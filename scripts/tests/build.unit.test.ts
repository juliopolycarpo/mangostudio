import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import {
  binaryCompileDefines,
  binaryCompileFlags,
  createTurboBuildCommand,
  discardStandaloneReadme,
  frontendDistAsidePath,
  selectBuildWorkspaces,
} from '../lib/build';
import { ROOT_DIR, WORKSPACES } from '../lib/config';
import { readText } from './support/read-text';

describe('discardStandaloneReadme', () => {
  test('removes a stale README and keeps the staged binaries', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mangostudio-build-readme-'));
    try {
      mkdirSync(join(outDir, 'linux-x64'));
      writeFileSync(join(outDir, 'README.md'), 'from an earlier successful build');
      writeFileSync(join(outDir, 'linux-x64', 'mangostudio'), 'binary');

      discardStandaloneReadme(outDir);

      expect(
        {
          readme: existsSync(join(outDir, 'README.md')),
          binary: existsSync(join(outDir, 'linux-x64', 'mangostudio')),
        },
        'expected README.md removed and the binary kept'
      ).toEqual({ readme: false, binary: true });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('does nothing when no README exists', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'mangostudio-build-readme-'));
    try {
      expect(() => discardStandaloneReadme(outDir)).not.toThrow();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

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

  test('compiles every standalone binary to ESM bytecode with external sourcemaps', () => {
    // Bytecode without `--format=esm` falls back to CommonJS, which rejects
    // the hub entry's top-level `await` and fails the compile.
    expect(binaryCompileFlags('production')).toEqual([
      '--bytecode',
      '--format=esm',
      '--sourcemap=external',
      '--minify',
    ]);
    expect(binaryCompileFlags('development')).toEqual([
      '--bytecode',
      '--format=esm',
      '--sourcemap=external',
    ]);
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

/**
 * What Turbo's default inputs would pick up: the untracked files Git does not
 * ignore, in a throwaway repository holding `gitignore` and one file under each
 * of `dirs`. The machine's own global ignore file is swapped for an empty one,
 * so the verdict belongs to the repository and not to whoever runs the test.
 */
function untrackedUnder(gitignore: string, dirs: readonly string[]): string[] {
  const repo = mkdtempSync(join(tmpdir(), 'mangostudio-aside-ignore-'));
  const git = (...args: string[]): string => {
    const result = Bun.spawnSync(['git', ...args], { cwd: repo });
    if (!result.success) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };
  try {
    git('init', '--quiet');
    const noGlobalIgnore = join(repo, '.git', 'no-global-ignore');
    writeFileSync(noGlobalIgnore, '');
    writeFileSync(join(repo, '.gitignore'), gitignore);
    for (const dir of dirs) {
      mkdirSync(join(repo, dir), { recursive: true });
      writeFileSync(join(repo, dir, 'index.html'), 'previous bundle');
    }
    const listed = git(
      '-c',
      `core.excludesFile=${noGlobalIgnore}`,
      'ls-files',
      '--others',
      '--exclude-standard'
    );
    return listed.split('\n').filter((file) => dirs.some((dir) => file.startsWith(`${dir}/`)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('frontendDistAsidePath', () => {
  const frontendDist = join(WORKSPACES.frontend.path, 'dist');
  const repoRelative = (path: string): string => relative(ROOT_DIR, path).split(sep).join('/');

  test('puts the previous bundle beside dist, one directory per pid', () => {
    const first = frontendDistAsidePath(frontendDist, 4242);
    const second = frontendDistAsidePath(frontendDist, 4243);
    const shape = {
      beside: dirname(first) === dirname(frontendDist),
      distinct: new Set([frontendDist, first, second]).size,
      keyedByPid: first.endsWith('4242'),
    };

    expect(
      shape,
      `expected backup beside dist, distinct per pid, keyed by pid: {"beside":true,"distinct":3,"keyedByPid":true} | received: ${JSON.stringify(shape)} (${first})`
    ).toEqual({ beside: true, distinct: 3, keyedByPid: true });
  });

  test('is the path withFrontendDistAside moves the bundle to', () => {
    const buildScript = readText('scripts/build.ts');

    expect(buildScript).toContain('frontendDistAsidePath(frontendDist, process.pid)');
    expect(buildScript).not.toContain('.aside-');
  });

  test('is listed as untracked when .gitignore has no rule for it', () => {
    // The control that keeps the next test honest: the probe must see an
    // unignored backup, or "nothing untracked" would pass for the wrong reason.
    const aside = repoRelative(frontendDistAsidePath(frontendDist, process.pid));

    expect(untrackedUnder('dist/\n', [aside])).toEqual([`${aside}/index.html`]);
  });

  test('is ignored by the root .gitignore, so Turbo never hashes the old bundle as frontend input', () => {
    const pids = [process.pid, 1, 2_147_483_647];
    const asides = pids.map((pid) => repoRelative(frontendDistAsidePath(frontendDist, pid)));
    const rule = `/${asides[0].replace(/\d+$/, '*')}/`;

    const untracked = untrackedUnder(readText('.gitignore'), asides);

    const verdict = untracked.length === 0 ? 'ignored' : `untracked ${untracked.join(', ')}`;
    expect(
      verdict,
      `expected dist backup ${asides[0]} (missing .gitignore rule: ${rule}): ignored | received: ${verdict}`
    ).toBe('ignored');
  });
});
