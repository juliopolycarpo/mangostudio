import { describe, expect, it } from 'bun:test';
import { posix, win32 } from 'node:path';
import {
  detectFnm,
  type FnmDetectionDeps,
  type FnmFileSystem,
  NODE_RELEASE_SCHEDULE,
} from '@mangostudio/shared/environments/detection';

const HOME = '/home/tester';
const DEFAULT_FNM_ROOT = `${HOME}/.local/share/fnm`;
const TODAY = new Date('2026-07-26T12:00:00.000Z');

/**
 * `directories` marks paths that exist as bare directories (the root itself,
 * for `resolveFnmRoot`'s existence check); `files` marks a node binary;
 * `symlinks` maps an alias path to what `realpath` resolves it to. All three
 * are compared with backslashes normalized to forward slashes, so a fixture
 * can use either separator style and still match a win32-built path.
 */
function createFakeFileSystem(fixture: {
  readonly directories?: readonly string[];
  readonly files?: readonly string[];
  readonly symlinks?: Readonly<Record<string, string>>;
}): FnmFileSystem {
  const normalize = (path: string) => path.replaceAll('\\', '/');
  const directories = new Set((fixture.directories ?? []).map(normalize));
  const files = new Set((fixture.files ?? []).map(normalize));
  const symlinks = new Map(
    Object.entries(fixture.symlinks ?? {}).map(([from, to]) => [normalize(from), to])
  );

  return {
    pathExists(path) {
      const target = normalize(path);
      return directories.has(target) || files.has(target) || symlinks.has(target);
    },
    readDirectory(path) {
      const prefix = `${normalize(path).replace(/\/$/, '')}/`;
      const entries = new Set<string>();
      for (const candidate of [...directories, ...files, ...symlinks.keys()]) {
        if (!candidate.startsWith(prefix)) continue;
        entries.add(candidate.slice(prefix.length).split('/')[0] as string);
      }
      return Promise.resolve([...entries]);
    },
    realpath(path) {
      return Promise.resolve(symlinks.get(normalize(path)) ?? path);
    },
  };
}

function posixInstall(root: string, version: string): { readonly file: string } {
  return { file: posix.join(root, 'node-versions', version, 'installation', 'bin', 'node') };
}

function fnmFixture(
  root = DEFAULT_FNM_ROOT,
  versions: readonly string[] = ['v24.18.0']
): { directories: string[]; files: string[] } {
  return {
    directories: [root],
    files: versions.map((version) => posixInstall(root, version).file),
  };
}

function createDeps(
  fixture: {
    directories?: readonly string[];
    files?: readonly string[];
    symlinks?: Record<string, string>;
  },
  overrides: Partial<Pick<FnmDetectionDeps, 'homeDir' | 'platform' | 'env'>> = {}
): FnmDetectionDeps {
  return {
    platform: 'linux',
    homeDir: HOME,
    env: {},
    fs: createFakeFileSystem(fixture),
    ...overrides,
  };
}

function detect(deps: FnmDetectionDeps, currentNodePath?: string) {
  return detectFnm(deps, {
    now: TODAY,
    schedule: NODE_RELEASE_SCHEDULE,
    ...(currentNodePath !== undefined && { currentNodePath }),
  });
}

describe('detectFnm', () => {
  it('enumerates normalized managed Node versions and identifies the current binary', async () => {
    const fixture = fnmFixture(DEFAULT_FNM_ROOT, ['v22.23.1', 'v24.18.0', 'v26.5.0']);
    const currentPath = posixInstall(DEFAULT_FNM_ROOT, 'v24.18.0').file;

    const status = await detect(createDeps(fixture), currentPath);

    expect(status.installed).toBe(true);
    expect(status.versions.map((version) => version.version)).toEqual([
      '26.5.0',
      '24.18.0',
      '22.23.1',
    ]);
    expect(status.currentVersion).toBe('24.18.0');
    expect(status.versions.find((version) => version.isCurrent)?.version).toBe('24.18.0');
  });

  it('resolves the default alias through realpath, matching it to the alias itself', async () => {
    const fixture = fnmFixture();
    const aliasPath = `${DEFAULT_FNM_ROOT}/aliases/default`;
    const target = posix.join(DEFAULT_FNM_ROOT, 'node-versions', 'v24.18.0', 'installation');

    const status = await detect(createDeps({ ...fixture, symlinks: { [aliasPath]: target } }));

    // fnm's default alias is a symlink straight to a version, so the alias
    // and the version it resolves to are the same string.
    expect(status.defaultAlias).toBe('24.18.0');
    expect(status.defaultVersion).toBe('24.18.0');
    expect(status.versions[0]?.isDefault).toBe(true);
  });

  it('reuses the runtime-scanned manager version instead of asking again', async () => {
    const status = await detectFnm(createDeps(fnmFixture()), {
      now: TODAY,
      schedule: NODE_RELEASE_SCHEDULE,
      managerVersion: '1.38.1',
    });

    expect(status.managerVersion).toBe('1.38.1');
  });

  it('honors FNM_DIR before the platform default', async () => {
    const customRoot = '/opt/fnm';
    const defaultFixture = fnmFixture();
    const customFixture = fnmFixture(customRoot, ['v22.23.1']);

    const status = await detect(
      createDeps(
        {
          directories: [...defaultFixture.directories, ...customFixture.directories],
          files: [...defaultFixture.files, ...customFixture.files],
        },
        { env: { FNM_DIR: customRoot } }
      )
    );

    expect(status.root).toBe(customRoot);
    expect(status.versions.map((version) => version.version)).toEqual(['22.23.1']);
  });

  it('falls back to the legacy ~/.fnm root when the platform default is absent', async () => {
    const legacyRoot = `${HOME}/.fnm`;
    const fixture = fnmFixture(legacyRoot, ['v22.23.1']);

    const status = await detect(createDeps(fixture));

    expect(status.root).toBe(legacyRoot);
  });

  it('returns a not-found status when no fnm root exists', async () => {
    const status = await detect(createDeps({}));

    expect(status).toEqual({
      id: 'fnm',
      installed: false,
      versions: [],
      findings: [{ code: 'not-found', params: { manager: 'fnm' } }],
    });
  });

  it('flags a configured default when no fnm-managed Node is effective on PATH', async () => {
    const fixture = fnmFixture();
    const aliasPath = `${DEFAULT_FNM_ROOT}/aliases/default`;
    const target = posix.join(DEFAULT_FNM_ROOT, 'node-versions', 'v24.18.0', 'installation');

    const status = await detect(createDeps({ ...fixture, symlinks: { [aliasPath]: target } }));

    expect(status.findings).toContainEqual({
      code: 'managed-but-not-on-path',
      params: {
        manager: 'fnm',
        defaultAlias: '24.18.0',
        defaultVersion: '24.18.0',
      },
    });
  });

  it('skips version directories that do not contain an installation binary', async () => {
    const fixture = fnmFixture();

    const status = await detect(
      createDeps({
        ...fixture,
        directories: [...fixture.directories, `${DEFAULT_FNM_ROOT}/node-versions/v22.23.1`],
      })
    );

    expect(status.versions.map((version) => version.version)).toEqual(['24.18.0']);
  });

  describe('on win32', () => {
    const WIN_HOME = 'C:\\Users\\tester';
    const WIN_ROOT = 'C:\\Users\\tester\\AppData\\Roaming\\fnm';

    function winInstall(root: string, version: string): string {
      return win32.join(root, 'node-versions', version, 'installation', 'node.exe');
    }

    it('resolves the default root from %APPDATA% and reads the node.exe layout', async () => {
      const nodePath = winInstall(WIN_ROOT, 'v24.18.0');
      const aliasPath = win32.join(WIN_ROOT, 'aliases', 'default');
      const target = win32.join(WIN_ROOT, 'node-versions', 'v24.18.0', 'installation');

      const status = await detect(
        createDeps(
          {
            directories: [WIN_ROOT],
            files: [nodePath],
            symlinks: { [aliasPath]: target },
          },
          {
            platform: 'win32',
            homeDir: WIN_HOME,
            env: { APPDATA: `${WIN_HOME}\\AppData\\Roaming` },
          }
        )
      );

      expect(status.installed).toBe(true);
      expect(status.root).toBe(WIN_ROOT);
      expect(status.versions.map((version) => version.version)).toEqual(['24.18.0']);
      expect(status.defaultVersion).toBe('24.18.0');
    });

    it('matches the current Node path case-insensitively', async () => {
      const nodePath = winInstall(WIN_ROOT, 'v24.18.0');
      // A differently-cased drive letter and directory segment — the same path
      // any Windows API can hand back — must still match the installation it
      // names. `findCurrentVersion`'s win32 branch is otherwise untested: nvm
      // never reaches it (it returns `installed: false` on win32 outright), so
      // fnm is the first detector that actually exercises the lowercase compare.
      const currentPath = nodePath.replace('C:\\Users\\tester', 'c:\\users\\tester');

      const status = await detect(
        createDeps(
          { directories: [WIN_ROOT], files: [nodePath] },
          {
            platform: 'win32',
            homeDir: WIN_HOME,
            env: { APPDATA: `${WIN_HOME}\\AppData\\Roaming` },
          }
        ),
        currentPath
      );

      expect(status.currentVersion).toBe('24.18.0');
    });
  });

  it('returns not-found on win32 with neither FNM_DIR nor %APPDATA% set', async () => {
    const status = await detect(createDeps({}, { platform: 'win32', env: {} }));

    expect(status.installed).toBe(false);
  });
});
