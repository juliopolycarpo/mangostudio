import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  binaryCompileDefines,
  binaryCompileFlags,
  createTurboBuildCommand,
  removeStaleChunkMaps,
  selectBuildWorkspaces,
} from '../lib/build';
import { readText } from './support/read-text';

/** Line of the fixture's `lazy.ts` that throws; a mapped stack must name it. */
const LAZY_THROW_LINE = 5;

/**
 * Compiles a three-module fixture with the production hub flags: an entry that
 * statically imports a shared `state` module, then dynamically imports a module
 * that imports the same `state` and throws.
 */
async function compileSplitFixture(dir: string) {
  const src = join(dir, 'src');
  const out = join(dir, 'out');
  mkdirSync(src);
  mkdirSync(out);
  await Bun.write(
    join(src, 'state.ts'),
    [
      'export const state = { loads: 0 };',
      'export function mark(): number {',
      '  state.loads += 1;',
      '  return state.loads;',
      '}',
      '',
    ].join('\n')
  );
  await Bun.write(
    join(src, 'entry.ts'),
    [
      "import { mark } from './state';",
      '',
      'mark();',
      "const lazy = await import('./lazy');",
      'lazy.report();',
      '',
    ].join('\n')
  );
  await Bun.write(
    join(src, 'lazy.ts'),
    [
      "import { mark } from './state';",
      '',
      'export function report(): void {',
      '  console.log(`loads=${mark()}`);',
      "  throw new Error('lazy chunk failure');",
      '}',
      '',
    ].join('\n')
  );

  // `--outfile` gains `.exe` on Windows, so the name is built to match.
  const executable = join(out, process.platform === 'win32' ? 'fixture.exe' : 'fixture');
  const compile = Bun.spawnSync({
    cmd: [
      'bun',
      'build',
      join(src, 'entry.ts'),
      '--compile',
      ...binaryCompileFlags('production'),
      '--outfile',
      executable,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const result = { exitCode: compile.exitCode, stderr: compile.stderr.toString().trim() };
  if (result.exitCode !== 0) return { ...result, executable };

  // Run a lone copy: the chunk `.map` files beside the compiled output must
  // not be what makes a lazy chunk load or a stack trace map.
  const alone = join(dir, 'alone');
  mkdirSync(alone);
  const lone = join(alone, basename(executable));
  copyFileSync(executable, lone);
  return { ...result, executable: lone };
}

describe('build script', () => {
  test('keeps only build-capable workspaces', () => {
    expect(selectBuildWorkspaces(['frontend', 'shared', 'api'])).toEqual({
      runnableWorkspaces: ['frontend', 'api'],
      skippedWorkspaces: ['shared'],
    });
  });

  test('creates one filtered Turbo invocation for selected workspaces', () => {
    expect(createTurboBuildCommand(['api', 'frontend'])).toEqual([
      'turbo',
      'run',
      'build',
      '--filter=@mangostudio/api',
      '--filter=@mangostudio/frontend',
    ]);
  });

  test('exposes explicit root build scripts for turbo and binary packaging', () => {
    const manifest = JSON.parse(readText('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts?.build).toBe('bun ./scripts/build.ts');
    expect(manifest.scripts?.['build:binary']).toBe('bun ./scripts/build.ts --binary');
    expect(manifest.scripts?.['build:turbo']).toBe('turbo run build');
  });

  test('declares package-local Turbo outputs for build caching', () => {
    const apiTurbo = readText('apps/api/turbo.json');
    const frontendTurbo = readText('apps/frontend/turbo.json');

    for (const turboConfig of [apiTurbo, frontendTurbo]) {
      expect(turboConfig).toContain('"extends": ["//"]');
      expect(turboConfig).toContain('"dist/**"');
    }

    // The frontend build writes its metafile beside dist/ rather than inside
    // it, which also puts it outside the `dist/**` glob: without a second
    // declared output a cache hit restores the bundle and leaves a metafile
    // from some other build sitting next to it.
    expect(frontendTurbo).toContain('"dist-metafile.json"');
  });

  test('delegates workspace builds to one filtered Turbo command', () => {
    const buildScript = readText('scripts/build.ts');

    expect(buildScript).toContain('createTurboBuildCommand');
    expect(buildScript).toContain("runCommand('build'");
    expect(buildScript).not.toContain('runParallel(');
  });

  test('keeps root formatting checks aware of Turbo configuration files', () => {
    const rootConfig = readText('scripts/lib/config.ts');

    expect(rootConfig).toContain("'turbo.jsonc'");
    expect(rootConfig).toContain("'apps/api/turbo.json'");
    expect(rootConfig).toContain("'apps/frontend/turbo.json'");
    expect(rootConfig).not.toContain('apps/runtime/');
  });

  test('bakes the release platform id into every standalone binary compile', () => {
    const defines = binaryCompileDefines({
      buildTime: '2026-01-01T00:00:00.000Z',
      buildInfo: { builtAt: '2026-01-01T00:00:00.000Z', gitSha: 'abc123def456', gitDirty: false },
      buildType: 'production',
      version: '0.1.0',
      platformId: 'linux-x64-musl',
    });

    expect(defines).toContain('process.env.BUILD_PLATFORM_ID="linux-x64-musl"');
  });

  test('compiles every standalone binary to split ESM bytecode with external sourcemaps', () => {
    // Bytecode without `--format=esm` falls back to CommonJS, which rejects
    // the hub entry's top-level `await`. `--splitting` moves each dynamically
    // imported module into its own chunk, loaded only when it is selected.
    expect(binaryCompileFlags('production')).toEqual([
      '--bytecode',
      '--format=esm',
      '--splitting',
      '--sourcemap=external',
      '--minify',
    ]);
    expect(binaryCompileFlags('development')).toEqual([
      '--bytecode',
      '--format=esm',
      '--splitting',
      '--sourcemap=external',
    ]);
  });

  test('a compiled split binary keeps one module instance and maps lazy-chunk errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mangostudio-split-compile-'));
    try {
      const fixture = await compileSplitFixture(dir);
      const run = Bun.spawnSync({
        cmd: [fixture.executable],
        // Neither the fixture sources nor the compile output directory.
        cwd: tmpdir(),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect({
        compileExit: fixture.exitCode,
        // Only a failed compile's stderr is evidence; a warning on success is not.
        compileFailure: fixture.exitCode === 0 ? null : fixture.stderr,
        stdout: run.stdout.toString().trim(),
        exitedWithError: run.exitCode !== 0,
        stackNamesLazySource: run.stderr.toString().includes(`lazy.ts:${LAZY_THROW_LINE}:`),
      }).toEqual({
        compileExit: 0,
        compileFailure: null,
        // 2 = the entry and the lazy chunk incremented the same `state` module.
        stdout: 'loads=2',
        exitedWithError: true,
        stackNamesLazySource: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('removes stale chunk maps from a platform output directory and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mangostudio-stale-maps-'));
    try {
      const compiled = await compileSplitFixture(dir);
      const out = join(dir, 'out');
      // What an earlier build left behind: a chunk map under a different hash.
      writeFileSync(join(out, 'entry-stale0000.js.map'), '{}');
      writeFileSync(join(out, 'fixture-runtime'), 'runtime');
      writeFileSync(join(out, 'README.md'), 'readme');

      const removed = removeStaleChunkMaps(out);
      const remaining = readdirSync(out).sort();

      expect({
        compileExit: compiled.exitCode,
        removedStale: removed.includes('entry-stale0000.js.map'),
        chunkMapsLeft: remaining.filter((name) => name.endsWith('.js.map')),
        // The binary, its entry map, the runtime and the README are not chunk maps.
        survivors: remaining.filter((name) => !name.endsWith('.js.map')),
      }).toEqual({
        compileExit: 0,
        removedStale: true,
        chunkMapsLeft: [],
        survivors: [
          'README.md',
          process.platform === 'win32' ? 'fixture.exe' : 'fixture',
          'fixture-runtime',
          'fixture.map',
        ].sort(),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('clears stale chunk maps before every standalone compile', () => {
    const source = readText('scripts/build.ts');
    const body = source.slice(source.indexOf('async function buildStandaloneTarget'));

    expect(body.indexOf('removeStaleChunkMaps(platformOutDir)')).toBeGreaterThan(-1);
    expect(body.indexOf('removeStaleChunkMaps(platformOutDir)')).toBeLessThan(
      body.indexOf('compileBinary(')
    );
  });

  test('uses the binary alias for standalone smoke builds', () => {
    expect(readText('scripts/test-build.ts')).toContain("'build:binary'");
  });

  test('loads the standalone smoke script before build output exists', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'scripts/test-build.ts'],
      env: {
        ...process.env,
        DISTRIBUTION_CHANNEL: 'test',
        DISTRIBUTION_MANIFEST_PATH: join(
          tmpdir(),
          'mangostudio-missing-distribution-manifest.json'
        ),
        PLATFORM: 'linux-x64-musl',
        SKIP_BUILD: '1',
        SOURCE_SHA: 'abcdef0',
      },
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(output).toContain('platform: linux-x64-musl');
    expect(output).toContain('Missing distribution manifest');
    expect(output).not.toContain('Building binary');
    expect(output).not.toContain('ReferenceError');
  });
});
