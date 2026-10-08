/**
 * Guard for the API test lanes: their `bun test` processes must start with a
 * fresh temporary HOME, never the developer's real one.
 *
 * The API unit and integration suites create and read `~/.mango` and
 * `~/.claude`, so a lane that inherits the real home writes test data into the
 * developer's own MangoStudio and passes or fails by what happens to be
 * installed there. Bun honours `HOME` only when a process starts, so this reads
 * the real launcher — the `test:*` scripts in `apps/api/package.json` — and
 * runs it, rather than checking a helper in isolation.
 */

import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { REAL_HOME_ENV, TEST_HOME_PREFIX, testHomeEnv } from '../lib/test-home';
import { laneById, type TestLaneId } from '../lib/test-lanes';
import { laneSpec, planWorkers, WORKERS_ENV } from '../lib/test-workers';
import { canonicalPath as canonical } from './support/canonical-path';

const ROOT = join(import.meta.dir, '..', '..');
const API_DIR = join(ROOT, 'apps', 'api');
const LAUNCHER = 'scripts/with-test-home.ts';

/** The lane scripts that start `bun test`, which must all go through the launcher. */
const LANE_SCRIPTS = [
  'test:unit',
  'test:integration',
  'test:coverage:unit',
  'test:coverage:integration',
];

const EXPECTED_SHAPE = join(tmpdir(), `${TEST_HOME_PREFIX}<random>`);

const scripts = JSON.parse(readFileSync(join(API_DIR, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>;

/** The developer's real home: the one an outer launcher recorded, else this process's own. */
const realHome = process.env[REAL_HOME_ENV]?.trim() || homedir();

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** The worker runner's call in a lane script: the lane it splits and the serial command it is given. */
function runnerCall(script: string): { laneId: TestLaneId; command: string[] } | null {
  const match = /run-test-workers\.ts\s+--lane=(\S+)\s+--\s+(bun test\b.*)$/.exec(script);
  if (!match?.[1] || !match[2]) return null;
  return { laneId: match[1] as TestLaneId, command: match[2].trim().split(/\s+/) };
}

/**
 * What precedes `bun test` in a lane script: the launcher itself, e.g.
 * `... bun ../../scripts/with-test-home.ts`, or for a script that goes through
 * the worker runner the launcher the runner starts every worker with.
 */
function launcherCommand(script: string): string[] | null {
  const match = /(\S+\/with-test-home\.ts)\s+bun test\b/.exec(script);
  if (match?.[1]) return [process.execPath, match[1]];
  const call = runnerCall(script);
  if (!call) return null;
  return [...laneSpec(laneById(call.laneId), call.command).launcher];
}

describe('API lane scripts start bun test through the temporary-home launcher', () => {
  for (const name of LANE_SCRIPTS) {
    test(`apps/api ${name}`, () => {
      const script = scripts[name] ?? '';

      expect(
        launcherCommand(script),
        `apps/api ${name} must start bun test through ${LAUNCHER}, which gives the lane a temporary HOME | expected: ... bun ../../${LAUNCHER} bun test ... | received: ${script || '(script missing)'}`
      ).not.toBeNull();
    });
  }

  test('no other apps/api script starts a bare bun test', () => {
    for (const [name, script] of Object.entries(scripts)) {
      if (!/\bbun test\b/.test(script)) continue;
      expect(
        launcherCommand(script),
        `apps/api script ${name} runs bun test with the real home | expected: through ${LAUNCHER} | received: ${script}`
      ).not.toBeNull();
    }
  });

  test('apps/api test:unit splits the lane across workers that each start through the launcher', () => {
    const call = runnerCall(scripts['test:unit'] ?? '');
    if (!call) {
      throw new Error(
        `apps/api test:unit must run through the worker runner | expected: ... bun ../../scripts/run-test-workers.ts --lane=api-unit -- bun test ... | received: ${scripts['test:unit']}`
      );
    }
    const spec = laneSpec(laneById(call.laneId), call.command);
    expect(
      spec.launcher.at(-1)?.replaceAll('\\', '/'),
      'the workers must start through the temporary-home launcher'
    ).toEndWith(`/${LAUNCHER}`);

    for (const plan of planWorkers(spec, 4, tmpdir())) {
      expect(
        plan.argv.slice(0, spec.launcher.length + 2),
        `worker ${plan.index}/${plan.count} must start bun test through ${LAUNCHER}, which gives it a temporary HOME of its own | received: ${plan.argv.join(' ')}`
      ).toEqual([...spec.launcher, 'bun', 'test']);
    }
  });

  test('the coverage lane stays one process: partitioned LCOV was not reproducible', () => {
    expect(
      runnerCall(scripts['test:coverage:unit'] ?? ''),
      'apps/api test:coverage:unit must stay a single bun test | expected: no run-test-workers.ts | received: a worker runner call'
    ).toBeNull();
  });

  test('the nightly randomized-order lane goes through the launcher too', () => {
    const workflow = readFileSync(
      join(ROOT, '.github', 'workflows', 'randomized-order-nightly.yml'),
      'utf8'
    );

    expect(
      workflow,
      `randomized-order-nightly.yml must start bun test through ${LAUNCHER} | expected: -- bun ../../${LAUNCHER} bun test`
    ).toContain(`-- bun ../../${LAUNCHER} bun test`);
  });
});

describe('what an API lane process sees as its home', () => {
  test('canonicalizes a removed test home through a temp directory alias', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'api-home-alias-'));
    try {
      const physical = join(sandbox, 'physical');
      const alias = join(sandbox, 'alias');
      mkdirSync(physical);
      symlinkSync(physical, alias, 'junction');
      const home = mkdtempSync(join(alias, TEST_HOME_PREFIX));
      const expected = realpathSync(home);
      rmSync(home, { recursive: true });
      expect(canonical(home)).toBe(expected);
      expect(dirname(canonical(home))).toBe(canonical(physical));
      expect(isInside(canonical(home), canonical(realHome))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  for (const name of LANE_SCRIPTS) {
    test(`apps/api ${name} resolves homedir() inside a fresh temporary directory`, async () => {
      const launcher = launcherCommand(scripts[name] ?? '');
      if (!launcher) throw new Error(`apps/api ${name} has no launcher; see the script pins above`);
      const probe = Bun.spawn({
        cmd: [
          ...launcher,
          'bun',
          '-e',
          'const { homedir, tmpdir } = require("node:os"); const { realpathSync } = require("node:fs"); console.log(JSON.stringify({ home: homedir(), canonicalHome: realpathSync(homedir()), tmpDir: realpathSync(tmpdir()) }))',
        ],
        cwd: API_DIR,
        env: process.env as Record<string, string>,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
        probe.exited,
      ]);
      expect(code, `expected launcher exit: 0 | received: ${code} | stderr: ${err.trim()}`).toBe(0);
      const { home, canonicalHome, tmpDir } = JSON.parse(
        out.trim().split('\n').at(-1) as string
      ) as {
        home: string;
        canonicalHome: string;
        tmpDir: string;
      };

      expect(canonical(home), 'expected removed home to retain its canonical OS path').toBe(
        canonicalHome
      );
      const canonicalRealHome = canonical(realHome);
      const usable =
        dirname(canonicalHome) === canonical(tmpDir) &&
        !isInside(canonicalRealHome, canonicalHome) &&
        !isInside(canonicalHome, canonicalRealHome) &&
        basename(canonicalHome).startsWith(TEST_HOME_PREFIX);
      expect(
        usable,
        `apps/api ${name} must start tests with a fresh temporary home | expected shape: ${EXPECTED_SHAPE} | resolved homedir(): ${home} | real home: ${realHome}`
      ).toBe(true);
      expect(existsSync(home), `expected the test home removed | still exists: ${home}`).toBe(
        false
      );
    });
  }
});

describe('preload abort', () => {
  const preload = readFileSync(join(API_DIR, 'tests', 'support', 'setup', 'preload.ts'), 'utf8');
  const check = readFileSync(
    join(API_DIR, 'tests', 'support', 'setup', 'hermetic-home.ts'),
    'utf8'
  );

  test('the preload runs the home check', () => {
    expect(
      preload,
      'apps/api preload must call assertHermeticHome() before it prepares the environment | expected: assertHermeticHome()'
    ).toContain('assertHermeticHome();');
  });

  test('the check reads the variable the launcher sets', () => {
    expect(
      check,
      `apps/api hermetic-home.ts must read ${REAL_HOME_ENV}, the variable ${LAUNCHER} sets | expected: '${REAL_HOME_ENV}'`
    ).toContain(`'${REAL_HOME_ENV}'`);
  });
});

/**
 * What Turbo makes of the lanes. The launcher is not part of `apps/api`, and
 * Turbo runs tasks with a strict environment, so both of these fail silently:
 * a launcher edit is served a stale cached pass, and a developer's
 * `CARGO_HOME` / `RUSTUP_HOME` / `BUN_INSTALL` never reaches the launcher that
 * pins them. `turbo run --dry=json` is Turbo's own answer, after it has merged
 * the root and workspace task definitions.
 *
 * Why `apps/api/turbo.json` is shaped the way it is (it stays comment-free, strict
 * JSON, so every tool parses it):
 * - Only `test:unit` is cached. The launcher lives outside the workspace, so it
 *   is named in `inputs` through `$TURBO_ROOT$`; `$TURBO_DEFAULT$` stays because
 *   an explicit list replaces the tracked package files.
 * - The toolchain homes are `passThroughEnv`, not `env`: they steer where tools
 *   live, not what a test sees, so they must stay out of the cache key.
 */
describe('Turbo task definitions of the API lanes', () => {
  /** The variables the launcher pins to the developer's real locations. */
  const PINNED_TOOLCHAIN_VARS = [
    'CARGO_HOME',
    'RUSTUP_HOME',
    'BUN_INSTALL',
    'BUN_INSTALL_CACHE_DIR',
  ];
  const TURBO_LANES = ['test:unit', 'test:integration', 'test:coverage'];

  interface DryRunTask {
    taskId: string;
    hash: string;
    inputs: Record<string, string>;
    resolvedTaskDefinition: { cache: boolean; passThroughEnv: string[] | null };
  }

  /**
   * The `scripts/` files the test:unit script loads: the launcher and the worker
   * runner, and every relative import of either, transitively.
   */
  function launcherFiles(
    entries: readonly string[] = ['scripts/with-test-home.ts', 'scripts/run-test-workers.ts'],
    seen = new Set<string>()
  ): string[] {
    for (const entry of entries) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      const source = readFileSync(join(ROOT, entry), 'utf8');
      // `from './x'` (imports and re-exports), a bare `import './x'`, and `import('./x')`.
      const imports = [...source.matchAll(/(?:from\s*|import\s*\(?\s*)'(\.{1,2}\/[^']+)'/g)].map(
        (match) => posix.join(posix.dirname(entry), `${match[1]}.ts`)
      );
      launcherFiles(imports, seen);
    }
    return [...seen];
  }

  async function dryRun(extraEnv: Record<string, string> = {}): Promise<Map<string, DryRunTask>> {
    const turbo = join(ROOT, 'node_modules', '.bin', 'turbo');
    const probe = Bun.spawn({
      cmd: [turbo, 'run', ...TURBO_LANES, '--filter=@mangostudio/api', '--dry=json'],
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    expect(code, `expected turbo dry run exit: 0 | received: ${code} | stderr: ${err.trim()}`).toBe(
      0
    );
    const { tasks } = JSON.parse(out) as { tasks: DryRunTask[] };
    return new Map(tasks.map((task) => [task.taskId.replace('@mangostudio/api#', ''), task]));
  }

  test('the test:unit closure is the ten files the cache key names', () => {
    expect(launcherFiles().sort()).toEqual([
      'scripts/lib/config.ts',
      'scripts/lib/junit-report.ts',
      'scripts/lib/log.ts',
      'scripts/lib/temp-home.ts',
      'scripts/lib/test-home.ts',
      'scripts/lib/test-lanes.ts',
      'scripts/lib/test-worker-process.ts',
      'scripts/lib/test-workers.ts',
      'scripts/run-test-workers.ts',
      'scripts/with-test-home.ts',
    ]);
  });

  test('the cached test:unit lane hashes every file its script loads', async () => {
    const task = (await dryRun()).get('test:unit');
    expect(task, 'expected a @mangostudio/api#test:unit task in the Turbo dry run').toBeDefined();
    expect(
      task?.resolvedTaskDefinition.cache,
      'expected test:unit to be cached, which is why its inputs matter'
    ).toBe(true);

    const hashed = Object.keys(task?.inputs ?? {});
    for (const file of launcherFiles()) {
      expect(
        hashed.includes(`../../${file}`),
        `a change to ${file} must invalidate the cached @mangostudio/api test:unit result | expected: "$TURBO_ROOT$/${file}" in the task's inputs in apps/api/turbo.json | received: ${hashed.length} hashed files, none of them ../../${file}`
      ).toBe(true);
    }
    expect(
      hashed.includes('package.json'),
      'an explicit inputs list replaces the tracked package files | expected: "$TURBO_DEFAULT$" kept in the inputs | received: apps/api/package.json not hashed'
    ).toBe(true);
  });

  test('every lane passes the pinned toolchain variables through', async () => {
    const tasks = await dryRun();
    for (const name of TURBO_LANES) {
      const passThrough = tasks.get(name)?.resolvedTaskDefinition.passThroughEnv ?? [];
      for (const variable of PINNED_TOOLCHAIN_VARS) {
        expect(
          passThrough,
          `Turbo's strict environment drops ${variable} before ${LAUNCHER} sees it, so a non-default location is replaced by the home-directory default | expected: "${variable}" in passThroughEnv of @mangostudio/api ${name} | received: [${passThrough.join(', ')}]`
        ).toContain(variable);
      }
    }
  });

  // The merged result is the same at any width, so a developer asking for two
  // workers must hit the cache entry the default width wrote. The variable still has
  // to reach the runner, and Turbo's strict environment drops anything
  // undeclared, so it is a pass-through and not an `env` entry.
  test('the worker count reaches the runner without changing the cached lane’s hash', async () => {
    const [unset, narrow, other] = [
      await dryRun(),
      await dryRun({ [WORKERS_ENV]: '2' }),
      await dryRun({ MANGOSTUDIO_SOMETHING_ELSE: '2' }),
    ];
    const passThrough = unset.get('test:unit')?.resolvedTaskDefinition.passThroughEnv ?? [];
    expect(
      passThrough,
      `Turbo's strict environment drops ${WORKERS_ENV} before the runner reads it | expected: "${WORKERS_ENV}" in passThroughEnv of @mangostudio/api test:unit | received: [${passThrough.join(', ')}]`
    ).toContain(WORKERS_ENV);
    expect(
      narrow.get('test:unit')?.hash,
      `${WORKERS_ENV}=2 must hit the entry written without it | expected: the unset hash ${unset.get('test:unit')?.hash} | received: ${narrow.get('test:unit')?.hash}`
    ).toBe(unset.get('test:unit')?.hash);
    // The control: a MANGOSTUDIO_* variable is hashed, so the comparison can differ.
    expect(other.get('test:unit')?.hash).not.toBe(unset.get('test:unit')?.hash);
  });

  test('the pass-through list covers every toolchain variable the launcher pins', () => {
    const pinned = Object.keys(testHomeEnv('/tmp/x', {}, { tmpDir: '/tmp', realHome: '/h' }));
    for (const variable of PINNED_TOOLCHAIN_VARS) {
      expect(pinned, `expected the launcher to pin ${variable}`).toContain(variable);
    }
  });
});
