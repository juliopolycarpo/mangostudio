import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, cpSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTurboCheckCommand } from '../lib/check';
import { ROOT_DIR, type WorkspaceName } from '../lib/config';
import { protocolCheckTasks } from '../protocol/tasks';
import { runTurbo, turboDryRun } from './support/turbo-run';
import { createTypecheckFixture, type TypecheckFixture } from './support/typecheck-fixture';

const WORKSPACES = ['apps/api', 'apps/frontend', 'apps/shared', 'packages/protocol'];
const fixtures: TypecheckFixture[] = [];
// These two CLI cases also compile dprint's plugins in a fresh writable cache.
// Keep that tool startup bounded separately from the small Turbo-only cases.
const ROOT_CHECK_TIMEOUT_MS = 60_000;

/** Real lint/cycle scripts and Turbo config, with only tsc replaced by the existing fake. */
function createFixture(): TypecheckFixture {
  const fixture = createTypecheckFixture();
  fixtures.push(fixture);
  const { root } = fixture;
  for (const file of [
    'biome.json',
    'biome.cycles.json',
    '.editorconfig',
    '.gitignore',
    'tsconfig.json',
    'dprint.json',
  ]) {
    copyFileSync(join(ROOT_DIR, file), join(root, file));
  }
  // Check formats only AGENTS.md and bunfig.toml in this fixture. Keep the
  // installed formatters, without fetching the unused remote YAML plugin.
  const formatter = JSON.parse(readFileSync(join(root, 'dprint.json'), 'utf8'));
  formatter.plugins = formatter.plugins.filter((plugin: string) => plugin.startsWith('./'));
  formatter.yaml = undefined;
  writeFileSync(join(root, 'dprint.json'), `${JSON.stringify(formatter, null, 2)}\n`);
  writeFileSync(
    join(root, '.gitignore'),
    `${readFileSync(join(root, '.gitignore'))}\n.turbo-cache/\n.dprint-cache/\n`
  );
  cpSync(join(ROOT_DIR, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
  for (const file of ['scripts/check.ts', 'scripts/check-import-cycles.ts']) {
    copyFileSync(join(ROOT_DIR, file), join(root, file));
  }
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  rootManifest.scripts = { check: 'bun ./scripts/check.ts' };
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(rootManifest, null, 2)}\n`);
  for (const workspace of WORKSPACES) {
    const path = join(root, workspace, 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const realManifest = JSON.parse(
      readFileSync(join(ROOT_DIR, workspace, 'package.json'), 'utf8')
    );
    for (const script of ['check', 'check:quick', 'check:cycles']) {
      manifest.scripts[script] = realManifest.scripts[script];
    }
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    copyFileSync(
      join(ROOT_DIR, workspace, 'tsconfig.json'),
      join(root, workspace, 'tsconfig.json')
    );
    if (workspace.startsWith('apps/')) {
      for (const file of ['AGENTS.md', 'bunfig.toml']) {
        copyFileSync(join(ROOT_DIR, workspace, file), join(root, workspace, file));
      }
    }
  }
  symlinkSync(join(ROOT_DIR, 'node_modules'), join(root, 'node_modules'), 'junction');
  for (const cmd of [
    ['git', 'init', '-q'],
    ['git', 'add', '.'],
  ]) {
    const result = Bun.spawnSync(cmd, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, `${cmd.join(' ')}: ${result.stderr}`).toBe(0);
  }
  return fixture;
}

function requiredCheck(fixture: TypecheckFixture, workspace: string) {
  const command =
    workspace === 'packages/protocol'
      ? protocolCheckTasks(['--ts-only'], { cargo: false, cargoHack: false })[0]?.cmd
      : createTurboCheckCommand([workspace.slice(5) as WorkspaceName]);
  expect(command?.[0]).toBe('turbo');
  return runTurbo(fixture.root, [
    ...(command?.slice(1) ?? []),
    ...fixture.turboArgs.filter((arg) => !arg.startsWith('--ui=')),
  ]);
}

async function rootCheck(fixture: TypecheckFixture, workspace: WorkspaceName) {
  const proc = Bun.spawn(['bun', 'run', 'check', `--${workspace}`], {
    cwd: fixture.root,
    env: {
      ...process.env,
      // Root test workers can inherit a read-only formatter cache. Keep this
      // fixture's real dprint invocation writable and independent of that home.
      DPRINT_CACHE_DIR: join(fixture.root, '.dprint-cache'),
      TURBO_CACHE_DIR: join(fixture.root, '.turbo-cache'),
      TURBO_TELEMETRY_DISABLED: '1',
      TURBO_NO_UPDATE_NOTIFIER: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function expectOutcome(
  run: { exitCode: number; stdout: string; stderr: string },
  outcome: 'pass' | 'fail'
): string {
  const output = run.stdout + run.stderr;
  expect(run.exitCode === 0, `expected ${outcome}, received exit ${run.exitCode}\n${output}`).toBe(
    outcome === 'pass'
  );
  return Bun.stripANSI(output);
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

describe('lint cache and required cycle scans', () => {
  for (const workspace of WORKSPACES) {
    test(`${workspace} rejects a new ignored cycle while replaying cached lint`, async () => {
      const fixture = createFixture();
      const packageName = JSON.parse(
        readFileSync(join(fixture.root, workspace, 'package.json'), 'utf8')
      ).name;
      expectOutcome(await requiredCheck(fixture, workspace), 'pass');
      const generated = join(fixture.root, workspace, 'build/new-cycle.ts');
      await Bun.write(
        generated,
        "import { cycle as self } from './new-cycle';\nexport const cycle = () => self();\n"
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const rejected = expectOutcome(await requiredCheck(fixture, workspace), 'fail');
        expect(rejected).toContain(`${packageName}:check:quick: cache hit`);
        expect(rejected).toContain(`${packageName}:check:cycles: cache bypass`);
        expect(rejected).toContain('lint/nursery/noSelfImport');
        expect(rejected.replaceAll('\\', '/')).toContain('build/new-cycle.ts');
      }
    });
  }

  test(
    'a lint failure invalidates a warm pass and reaches the root check exit',
    async () => {
      const fixture = createFixture();
      expectOutcome(await rootCheck(fixture, 'frontend'), 'pass');
      fixture.writeSource('@mangostudio/frontend', 'export const bad=2;\n');
      const rejected = expectOutcome(await rootCheck(fixture, 'frontend'), 'fail');
      // GitHub Actions groups a task under its own header instead of prefixing
      // each line as a local streamed run does. Require the same task/cache state.
      expect(rejected).toMatch(/@mangostudio\/frontend:check:quick(?:: |\r?\n)cache miss/);
      expect(rejected).toContain('format');
      expect(rejected).toContain('src/index.ts');
    },
    ROOT_CHECK_TIMEOUT_MS
  );

  test(
    'an upstream typecheck failure still reaches the root check exit',
    async () => {
      const fixture = createFixture();
      expectOutcome(await rootCheck(fixture, 'frontend'), 'pass');
      fixture.breakSource('@mangostudio/protocol');
      const rejected = expectOutcome(await rootCheck(fixture, 'frontend'), 'fail');
      expect(rejected).toContain('@mangostudio/protocol:typecheck');
      expect(rejected).toContain('error TS2322');
    },
    ROOT_CHECK_TIMEOUT_MS
  );
});

describe('lint cache inputs', () => {
  for (const file of [
    'biome.json',
    '.editorconfig',
    '.gitignore',
    'tsconfig.json',
    'turbo.jsonc',
    'apps/frontend/tsconfig.json',
    'apps/frontend/package.json',
    'apps/frontend/src/index.ts',
    'apps/shared/src/index.ts',
    'packages/protocol/src/index.ts',
  ]) {
    test(`editing ${file} invalidates frontend lint`, async () => {
      const fixture = createFixture();
      const args = ['run', 'check:quick', '--filter=@mangostudio/frontend', ...fixture.turboArgs];
      const hash = async () => {
        const task = (await turboDryRun(fixture.root, args)).find(
          (task) => task.taskId === '@mangostudio/frontend#check:quick'
        );
        expect(task, 'frontend lint must be selected').toBeDefined();
        return task?.hash;
      };
      const before = await hash();
      const path = join(fixture.root, file);
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
      expect(await hash(), `${file} changed but frontend lint retained its hash`).not.toBe(before);
    });
  }
});
