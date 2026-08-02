import { describe, expect, it } from 'bun:test';
import { posix } from 'node:path';
import {
  detectNvm,
  NODE_RELEASE_SCHEDULE,
  type NvmDetectionDeps,
  type NvmFileSystem,
} from '@mangostudio/shared/environments/detection';

const HOME = '/home/tester';
const DEFAULT_NVM_ROOT = `${HOME}/.nvm`;
const TODAY = new Date('2026-07-26T12:00:00.000Z');

function createFakeFileSystem(files: Record<string, string>): NvmFileSystem {
  const normalizedFiles = new Map(
    Object.entries(files).map(([path, contents]) => [posix.normalize(path), contents])
  );

  return {
    pathExists(path) {
      return normalizedFiles.has(posix.normalize(path));
    },
    readFile(path) {
      const value = normalizedFiles.get(posix.normalize(path));
      return value === undefined
        ? Promise.reject(new Error(`Missing fake file: ${path}`))
        : Promise.resolve(value);
    },
    readDirectory(path) {
      const directory = `${posix.normalize(path).replace(/\/$/, '')}/`;
      const entries = new Set<string>();
      for (const file of normalizedFiles.keys()) {
        if (!file.startsWith(directory)) continue;
        const entry = file.slice(directory.length).split('/')[0];
        if (entry) entries.add(entry);
      }
      return Promise.resolve([...entries]);
    },
    realpath(path) {
      return Promise.resolve(posix.normalize(path));
    },
  };
}

function nvmFiles(
  root = DEFAULT_NVM_ROOT,
  versions: readonly string[] = ['v24.18.0']
): Record<string, string> {
  return Object.fromEntries([
    [
      `${root}/nvm.sh`,
      'case "$1" in\n  "--version" | "-v")\n    nvm_echo \'0.40.6\'\n  ;;\nesac\n',
    ],
    ...versions.map((version) => [`${root}/versions/node/${version}/bin/node`, 'binary']),
  ]);
}

function createDeps(
  files: Record<string, string>,
  overrides: Partial<Pick<NvmDetectionDeps, 'homeDir' | 'platform' | 'env'>> = {}
): NvmDetectionDeps {
  return {
    platform: 'linux',
    homeDir: HOME,
    env: {},
    fs: createFakeFileSystem(files),
    ...overrides,
  };
}

function detect(deps: NvmDetectionDeps, currentNodePath?: string) {
  return detectNvm(deps, {
    now: TODAY,
    schedule: NODE_RELEASE_SCHEDULE,
    ...(currentNodePath !== undefined && { currentNodePath }),
  });
}

describe('detectNvm', () => {
  it('enumerates normalized managed Node versions and identifies the current binary', async () => {
    const files = nvmFiles(DEFAULT_NVM_ROOT, ['v22.23.1', 'v24.18.0', 'v26.5.0']);
    const currentPath = `${DEFAULT_NVM_ROOT}/versions/node/v24.18.0/bin/node`;

    const status = await detect(createDeps(files), currentPath);

    expect(status.installed).toBe(true);
    expect(status.managerVersion).toBe('0.40.6');
    expect(status.versions.map((version) => version.version)).toEqual([
      '26.5.0',
      '24.18.0',
      '22.23.1',
    ]);
    expect(status.currentVersion).toBe('24.18.0');
    expect(status.versions.find((version) => version.isCurrent)?.version).toBe('24.18.0');
  });

  it('resolves lts/* through the nvm LTS alias cache', async () => {
    const files = {
      ...nvmFiles(),
      [`${DEFAULT_NVM_ROOT}/alias/default`]: 'lts/*\n',
      [`${DEFAULT_NVM_ROOT}/alias/lts/*`]: 'v24.18.0\n',
      [`${DEFAULT_NVM_ROOT}/alias/lts/krypton`]: 'v24.18.0\n',
    };

    const status = await detect(createDeps(files));

    expect(status.defaultAlias).toBe('lts/*');
    expect(status.defaultVersion).toBe('24.18.0');
    expect(status.versions[0]?.isDefault).toBe(true);
  });

  it('follows the lts/* pointer that real nvm writes into its alias cache', async () => {
    const files = {
      ...nvmFiles(),
      [`${DEFAULT_NVM_ROOT}/alias/default`]: 'lts/*\n',
      [`${DEFAULT_NVM_ROOT}/alias/lts/*`]: 'lts/krypton\n',
      [`${DEFAULT_NVM_ROOT}/alias/lts/krypton`]: 'v24.18.0\n',
      [`${DEFAULT_NVM_ROOT}/alias/lts/jod`]: 'v22.23.1\n',
    };

    const status = await detect(createDeps(files));

    expect(status.defaultVersion).toBe('24.18.0');
  });

  it('resolves a concrete default version directly', async () => {
    const files = {
      ...nvmFiles(DEFAULT_NVM_ROOT, ['v22.13.0']),
      [`${DEFAULT_NVM_ROOT}/alias/default`]: '22.13.0\n',
    };

    const status = await detect(createDeps(files));

    expect(status.defaultVersion).toBe('22.13.0');
    expect(status.versions[0]?.isDefault).toBe(true);
  });

  it('honors NVM_DIR before the default home directory', async () => {
    const customRoot = '/opt/nvm';
    const files = {
      ...nvmFiles(),
      ...nvmFiles(customRoot, ['v22.23.1']),
    };

    const status = await detect(createDeps(files, { env: { NVM_DIR: customRoot } }));

    expect(status.root).toBe(customRoot);
    expect(status.versions.map((version) => version.version)).toEqual(['22.23.1']);
  });

  it('returns a not-found status when no nvm.sh exists', async () => {
    const status = await detect(createDeps({}));

    expect(status).toEqual({
      id: 'nvm',
      installed: false,
      versions: [],
      findings: [{ code: 'not-found', params: { manager: 'nvm' } }],
    });
  });

  it('flags a configured default when no nvm-managed Node is effective on PATH', async () => {
    const files = {
      ...nvmFiles(),
      [`${DEFAULT_NVM_ROOT}/alias/default`]: '24.18.0\n',
    };

    const status = await detect(createDeps(files));

    expect(status.findings).toContainEqual({
      code: 'managed-but-not-on-path',
      params: {
        manager: 'nvm',
        defaultAlias: '24.18.0',
        defaultVersion: '24.18.0',
      },
    });
  });

  it('skips version directories that do not contain bin/node', async () => {
    const files = {
      ...nvmFiles(),
      [`${DEFAULT_NVM_ROOT}/versions/node/v22.23.1/README.md`]: 'incomplete install',
    };

    const status = await detect(createDeps(files));

    expect(status.versions.map((version) => version.version)).toEqual(['24.18.0']);
  });

  it('does not apply the POSIX nvm layout on Windows', async () => {
    const status = await detect(createDeps(nvmFiles(), { platform: 'win32' }));

    expect(status.installed).toBe(false);
  });
});
