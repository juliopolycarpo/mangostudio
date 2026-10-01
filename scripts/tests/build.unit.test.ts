import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  binaryCompileDefines,
  binaryCompileFlags,
  createTurboBuildCommand,
  selectBuildWorkspaces,
} from '../lib/build';
import { readText } from './support/read-text';

/** A module whose functions nest five levels deep, so a bytecode depth of 2 has something to skip. */
function nestedFunctionsSource(): string {
  const lines = ['export function outer(a: number): number[] {'];
  for (let i = 0; i < 40; i++) {
    lines.push(
      `  function f${i}(x: number) { function g${i}(y: number) { function h${i}(z: number) {` +
        ` function k${i}(w: number) { return w + ${i} + x + y + z; } return k${i}(z) * 2; }` +
        ` return h${i}(y) + 1; } return g${i}(x) + ${i}; }`
    );
  }
  const calls = Array.from({ length: 40 }, (_, i) => `f${i}(a)`).join(', ');
  lines.push(`  return [${calls}];`, '}', 'console.log(outer(1).length);');
  return `${lines.join('\n')}\n`;
}

/** Compile the nested fixture for this host with the given flags; returns the executable's path and size. */
function compileNestedFixture(dir: string, name: string, flags: string[]) {
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, nestedFunctionsSource());
  const outfile = join(dir, name);
  const result = Bun.spawnSync({
    cmd: ['bun', 'build', entry, '--compile', ...flags, '--outfile', outfile],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `compile with ${JSON.stringify(flags)} exited ${result.exitCode}: ${result.stderr.toString()}`
    );
  }
  return { outfile, bytes: statSync(outfile).size };
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

  test('compiles every standalone binary to depth-2 ESM bytecode with external sourcemaps', () => {
    // Bytecode without `--format=esm` falls back to CommonJS, which rejects
    // the hub entry's top-level `await` and fails the compile.
    expect(binaryCompileFlags('production')).toEqual([
      '--bytecode',
      '--bytecode-depth=2',
      '--format=esm',
      '--sourcemap=external',
      '--minify',
    ]);
    expect(binaryCompileFlags('development')).toEqual([
      '--bytecode',
      '--bytecode-depth=2',
      '--format=esm',
      '--sourcemap=external',
    ]);
  });

  test('the depth flag changes what Bun compiles, and the compiled executable still runs', () => {
    // Bun accepts a misspelled `--bytecode-depth` without complaint and compiles at the
    // default depth, so the flag array alone does not prove the depth took effect.
    const dir = mkdtempSync(join(tmpdir(), 'mangostudio-bytecode-depth-'));
    try {
      const flags = binaryCompileFlags('production');
      const shallow = compileNestedFixture(dir, 'shallow', flags);
      const full = compileNestedFixture(
        dir,
        'full',
        flags.filter((flag) => !flag.startsWith('--bytecode-depth'))
      );
      const run = Bun.spawnSync({ cmd: [shallow.outfile], cwd: dir });

      expect(
        shallow.bytes < full.bytes,
        `expected the depth-limited executable smaller than the all-levels one | received: ${shallow.bytes} B vs ${full.bytes} B`
      ).toBe(true);
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString().trim()).toBe('40');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
