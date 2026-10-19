import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import {
  findProtectedFile,
  runProtectGeneratedHook,
} from '../../.claude/hooks/protect-generated.mjs';
import {
  createPathExportLine,
  resolveRepoBin,
  updateClaudeEnvPath,
} from '../../.claude/hooks/session-path.mjs';
import {
  candidatePaths,
  chooseFormatter,
  extractTouchedFilePath,
  isInsideRepo,
  runAutoFixHook,
  shouldSkipFile,
} from '../../.codex/hooks/auto-fix.mjs';
import { fixtureChildEnvironment } from './support/child-supervision';
import {
  GRANDCHILD_ENV,
  grandchildMarker,
  HANG_ENV,
  HEARTBEAT_MS,
  heartbeatPath,
  MARKER_ENV,
} from './support/fake-rustfmt-markers';

const repoRoot = join(import.meta.dir, '..', '..');
const tempDirs: string[] = [];
const hookEntrypoints = [
  ['Codex', join(repoRoot, '.codex', 'hooks', 'auto-fix.mjs')],
  ['Claude', join(repoRoot, '.claude', 'hooks', 'auto-fix.mjs')],
] as const;
// A rustup proxy on PATH does not mean the pinned formatter is installed.
const installedRustfmt = Bun.which('rustup')
  ? Bun.spawnSync(['rustup', 'which', 'rustfmt'], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 5000,
    }).exitCode === 0
  : Boolean(Bun.which('rustfmt'));

async function makeTempDir() {
  const path = await mkdtemp(join(tmpdir(), 'mango-agent-hooks-'));
  tempDirs.push(path);
  return path;
}

/** Reads a fake's marker, naming the fake that never started instead of a bare ENOENT. */
async function readMarker(marker: string, who: string) {
  const text = await readFile(marker, 'utf8').catch(() => {
    throw new Error(`${who} never started | expected: a marker at ${marker} | received: none`);
  });
  return JSON.parse(text) as { args: string[]; cwd: string; pid: number };
}

/**
 * True when the fake behind `marker` still beats. A stopped process cannot, so unlike a pid
 * probe this never mistakes an unrelated process that reused the pid for the fake.
 */
async function stillBeating(marker: string) {
  const read = () => readFile(heartbeatPath(marker), 'utf8').catch(() => '');
  const before = await read();
  await Bun.sleep(HEARTBEAT_MS * 6);
  return (await read()) !== before;
}

/**
 * Waits for the fake behind `marker` to beat once, naming it if it never does.
 *
 * @example
 * await firstHeartbeat(marker, 'fake rustfmt');
 */
async function firstHeartbeat(marker: string, who: string, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await Bun.file(heartbeatPath(marker)).exists()) return;
    await Bun.sleep(HEARTBEAT_MS);
  }
  throw new Error(
    `${who} never beat | expected: ${heartbeatPath(marker)} within ${timeoutMs}ms | received: none`
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('agent auto-fix hooks', () => {
  let fakeRustfmtBin = '';

  beforeAll(async () => {
    // A native executable exercises the hook's real PATH lookup on Windows too.
    fakeRustfmtBin = await mkdtemp(join(tmpdir(), 'mango-fake-rustfmt-'));
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, 'support', 'fake-rustfmt.ts')],
      compile: {
        outfile: join(fakeRustfmtBin, process.platform === 'win32' ? 'rustfmt.exe' : 'rustfmt'),
        // The fake runs in the repo root; its bunfig.toml and .env are not the fake's.
        autoloadDotenv: false,
        autoloadBunfig: false,
      },
    });
    expect(result.success, result.logs.map(String).join('\n')).toBe(true);
  }, 30_000);

  afterAll(async () => {
    if (fakeRustfmtBin) await rm(fakeRustfmtBin, { recursive: true, force: true });
  });

  /** The environment of a hook whose rustfmt hangs and starts a grandchild. */
  const hangingFormatterEnv = (marker: string) => ({
    // The hook must stop rustfmt itself; inherited --no-orphans would mask a leak.
    ...fixtureChildEnvironment(),
    PATH: `${fakeRustfmtBin}${delimiter}${process.env.PATH}`,
    [MARKER_ENV]: marker,
    [HANG_ENV]: '1',
    [GRANDCHILD_ENV]: '0',
  });

  it('extracts touched files from Claude and Codex hook payloads', () => {
    const claudeInput = JSON.stringify({ tool_input: { file_path: 'apps/api/src/app.ts' } });
    const codexInput = JSON.stringify({ path: 'README.md' });

    expect(extractTouchedFilePath(claudeInput)).toBe('apps/api/src/app.ts');
    expect(extractTouchedFilePath(codexInput)).toBe('README.md');
    expect(extractTouchedFilePath('not json')).toBe('');
  });

  it('keeps formatting scoped to files inside the repo', () => {
    const root = join('workspace', 'mangostudio');

    expect(isInsideRepo(join(root, 'README.md'), root)).toBe(true);
    expect(isInsideRepo(join('workspace', 'other', 'README.md'), root)).toBe(false);
  });

  it('skips generated and dependency files', () => {
    expect(shouldSkipFile(join('repo', 'node_modules', 'pkg', 'index.ts'))).toBe(true);
    expect(shouldSkipFile(join('repo', 'apps', 'frontend', 'src', 'routeTree.gen.ts'))).toBe(true);
    expect(shouldSkipFile(join('repo', 'apps', 'api', 'src', 'app.ts'))).toBe(false);
  });

  it('chooses the formatter from the touched file name', () => {
    expect(chooseFormatter('src/app.ts')).toBe('biome');
    expect(chooseFormatter('docs/README.md')).toBe('dprint');
    expect(chooseFormatter('Dockerfile.release')).toBe('dprint');
    expect(chooseFormatter('crates/mango-protocol/src/lib.rs')).toBe('rustfmt');
    expect(chooseFormatter('assets/logo.png')).toBeUndefined();
  });

  it.skipIf(!installedRustfmt)('formats a touched Rust file with rustfmt', async () => {
    const dir = join(repoRoot, '.mango', `agent-hooks-${process.pid}-${Date.now()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'sample.rs');
    await writeFile(filePath, 'fn  main( ){let x=1;}\n', 'utf8');

    await runAutoFixHook(JSON.stringify({ tool_input: { file_path: filePath } }));

    expect(await readFile(filePath, 'utf8')).toBe('fn main() {\n    let x = 1;\n}\n');
  });

  it('bounds a formatter that never exits, grandchildren included', async () => {
    const dir = await makeTempDir();
    const marker = join(dir, 'started.json');
    const filePath = join(repoRoot, '.mango', `formatter-timeout-${process.pid}.rs`);
    tempDirs.push(filePath);
    await writeFile(filePath, 'fn main() {}\n');
    // The formatter deadline includes startup, before the fake can write its marker.
    const startedAt = performance.now();
    const proc = Bun.spawn([process.execPath, hookEntrypoints[0][1]], {
      env: hangingFormatterEnv(marker),
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 8000,
    });
    proc.stdin.write(JSON.stringify({ path: filePath }));
    proc.stdin.end();

    const exitCode = await proc.exited;
    const elapsedMs = performance.now() - startedAt;
    const fakes = [
      [marker, 'fake rustfmt'],
      [grandchildMarker(marker), 'the grandchild of fake rustfmt'],
    ] as const;
    const leaked: number[] = [];
    try {
      expect(exitCode).toBe(0);
      expect(proc.signalCode).toBeNull();
      expect(elapsedMs).toBeGreaterThanOrEqual(4500);
      expect(elapsedMs).toBeLessThan(7000);
      for (const [fakeMarker, who] of fakes) {
        const started = await readMarker(fakeMarker, who);
        expect(started.args).toEqual([filePath]);
        expect(started.cwd).toBe(repoRoot);
        if (await stillBeating(fakeMarker)) leaked.push(started.pid);
      }
      expect(leaked).toEqual([]);
      expect(await readFile(filePath, 'utf8')).toBe('fn main() {}\n');
    } finally {
      for (const pid of leaked) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Stopped between the heartbeat check and here.
        }
      }
    }
  }, 10000);

  // Windows has no group signal to forward; Bun's job object ends the hook's children there.
  it.skipIf(process.platform === 'win32')(
    'stops the formatter tree when the agent cancels the hook before the deadline',
    async () => {
      const dir = await makeTempDir();
      const marker = join(dir, 'started.json');
      const filePath = join(repoRoot, '.mango', `formatter-cancel-${process.pid}.rs`);
      tempDirs.push(filePath);
      await writeFile(filePath, 'fn main() {}\n');
      // An agent cancels a hook by signalling the group it started the hook in.
      const proc = Bun.spawn([process.execPath, hookEntrypoints[0][1]], {
        env: hangingFormatterEnv(marker),
        detached: true,
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 8000,
      });
      proc.stdin.write(JSON.stringify({ path: filePath }));
      proc.stdin.end();

      const fakes = [
        [marker, 'fake rustfmt'],
        [grandchildMarker(marker), 'the grandchild of fake rustfmt'],
      ] as const;
      const leaked: number[] = [];
      try {
        for (const [fakeMarker, who] of fakes) await firstHeartbeat(fakeMarker, who);
        process.kill(-proc.pid, 'SIGTERM');
        await proc.exited;
        for (const [fakeMarker, who] of fakes) {
          const started = await readMarker(fakeMarker, who);
          if (await stillBeating(fakeMarker)) leaked.push(started.pid);
        }
        expect(leaked).toEqual([]);
        expect(proc.exitCode).toBe(143);
      } finally {
        for (const pid of leaked) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Stopped between the heartbeat check and here.
          }
        }
      }
    },
    10000
  );

  it('lists cwd-relative paths before repo-root ones only for a cwd inside the repo', () => {
    const root = resolve('/workspace', 'mangostudio');
    const outside = resolve('/workspace', 'other');
    const nested = join(root, 'crates', 'foo');

    expect(candidatePaths('src/lib.rs', nested, root)).toEqual([
      join(nested, 'src', 'lib.rs'),
      join(root, 'src', 'lib.rs'),
    ]);
    expect(candidatePaths('src/lib.rs', root, root)).toEqual([join(root, 'src', 'lib.rs')]);
    expect(candidatePaths('lib.rs', outside, root)).toEqual([join(outside, 'lib.rs')]);
    expect(candidatePaths(join(nested, 'lib.rs'), root, root)).toEqual([join(nested, 'lib.rs')]);
    expect(candidatePaths('', root, root)).toEqual([]);
  });

  it.each(
    hookEntrypoints.flatMap(([agent, entrypoint]) => [
      [agent, 'cwd-relative', entrypoint, () => 'sample.rs'] as const,
      [
        agent,
        'repo-relative',
        entrypoint,
        (dir: string) => relative(repoRoot, join(dir, 'sample.rs')),
      ] as const,
    ])
  )(
    'the %s hook formats a %s touched file from a nested cwd',
    async (_agent, _kind, entrypoint, touchedPath) => {
      const bin = await makeTempDir();
      const marker = join(bin, 'formatted');
      const dir = join(repoRoot, '.mango', `agent-hooks-cwd-${process.pid}-${Date.now()}`);
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'sample.rs'), 'fn main() {}\n');
      const proc = Bun.spawn([process.execPath, entrypoint], {
        env: {
          ...process.env,
          PATH: `${fakeRustfmtBin}${delimiter}${process.env.PATH}`,
          [MARKER_ENV]: marker,
          [HANG_ENV]: '0',
        },
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 8000,
      });
      proc.stdin.write(JSON.stringify({ cwd: dir, path: touchedPath(dir) }));
      proc.stdin.end();

      expect(await proc.exited).toBe(0);
      const recorded = await readMarker(marker, 'fake rustfmt');
      expect(recorded.args).toEqual([join(dir, 'sample.rs')]);
      expect(recorded.cwd).toBe(repoRoot);
    },
    10000
  );

  it('ignores missing touched files without failing the hook', async () => {
    await expect(
      runAutoFixHook(JSON.stringify({ path: 'missing-file.ts' }))
    ).resolves.toBeUndefined();
  });
});

describe('Claude session path hook', () => {
  it('creates a shell export that prepends the repo bin path', () => {
    expect(createPathExportLine('/repo/node_modules/.bin', ':')).toBe(
      'export PATH=\'/repo/node_modules/.bin:\'"$PATH"\n'
    );
  });

  it('resolves the repo-local binary directory', () => {
    expect(resolveRepoBin('/repo')).toBe(join('/repo', 'node_modules', '.bin'));
    expect(resolveRepoBin('')).toBe('');
  });

  it('writes the Claude env file when the repo bin exists', async () => {
    const projectDir = await makeTempDir();
    const envFile = join(projectDir, 'claude-env');
    const repoBin = resolveRepoBin(projectDir);
    await mkdir(repoBin, { recursive: true });
    await writeFile(envFile, '', 'utf8');

    await updateClaudeEnvPath({ CLAUDE_ENV_FILE: envFile, CLAUDE_PROJECT_DIR: projectDir });

    expect(await readFile(envFile, 'utf8')).toBe(createPathExportLine(repoBin, delimiter));
  });
});

describe('Claude protect-generated hook', () => {
  const root = join('/workspace', 'mangostudio');

  it.each([
    ['CHANGELOG.md', 'bun run changelog'],
    ['packages/protocol/CHANGELOG.md', 'bun run protocol:release:prepare'],
    ['apps/frontend/src/routeTree.gen.ts', 'bun run --filter @mangostudio/frontend routes'],
    ['bun.lock', 'bun install'],
    ['Cargo.lock', 'cargo update'],
    ['crates/mango-protocol/fuzz/Cargo.lock', 'cargo update -w --manifest-path'],
    ['apps/shared/src/runtime-contract/generated/catalog.json', 'bun run contracts:emit'],
  ])('protects generated file %s', (path, regenerate) => {
    const match = findProtectedFile(join(root, path), root);

    expect(match?.path).toBe(path);
    expect(match?.regenerate).toContain(regenerate);
  });

  it('protects generated files inside a nested agent worktree', () => {
    const match = findProtectedFile(join(root, '.claude', 'worktrees', 'wt', 'bun.lock'), root);

    expect(match?.path).toBe('bun.lock');
  });

  it('allows hand-written files and files outside the repo', () => {
    expect(findProtectedFile(join(root, 'apps', 'api', 'src', 'app.ts'), root)).toBeUndefined();
    expect(findProtectedFile(join(root, 'docs', 'CHANGELOG-notes.md'), root)).toBeUndefined();
    expect(findProtectedFile(join('/workspace', 'other', 'CHANGELOG.md'), root)).toBeUndefined();
  });

  it('blocks a protected edit with the path and the regeneration command', () => {
    const input = JSON.stringify({ tool_input: { file_path: join(root, 'CHANGELOG.md') } });

    const result = runProtectGeneratedHook(input, root);

    expect(result.blocked).toBe(true);
    expect(result.message).toContain('CHANGELOG.md');
    expect(result.message).toContain('bun run changelog');
  });

  it('resolves relative edits from the tool working directory', () => {
    const input = JSON.stringify({
      cwd: join(root, 'packages', 'protocol'),
      tool_input: { file_path: 'CHANGELOG.md' },
    });
    expect(runProtectGeneratedHook(input, root).message).toContain(
      'bun run protocol:release:prepare'
    );
    const outside = JSON.stringify({
      cwd: '/workspace/other',
      tool_input: { file_path: 'CHANGELOG.md' },
    });
    expect(runProtectGeneratedHook(outside, root).blocked).toBe(false);
  });

  it('falls back to the repo root for a repo-relative path from a nested cwd', () => {
    const input = JSON.stringify({
      cwd: join(root, 'packages', 'protocol'),
      tool_input: { file_path: 'packages/protocol/CHANGELOG.md' },
    });

    expect(runProtectGeneratedHook(input, root).message).toContain(
      'bun run protocol:release:prepare'
    );
  });

  it('lets unprotected and unparseable payloads through', () => {
    const input = JSON.stringify({ tool_input: { file_path: join(root, 'README.md') } });

    expect(runProtectGeneratedHook(input, root)).toEqual({ blocked: false, message: '' });
    expect(runProtectGeneratedHook('not json', root)).toEqual({ blocked: false, message: '' });
  });

  it('exits with code 2 and a stderr reason when run as a Claude hook', async () => {
    const proc = Bun.spawn(
      [process.execPath, join(repoRoot, '.claude', 'hooks', 'protect-generated.mjs')],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
    );
    proc.stdin.write(JSON.stringify({ tool_input: { file_path: join(repoRoot, 'bun.lock') } }));
    proc.stdin.end();

    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain('bun install');
  });
});
