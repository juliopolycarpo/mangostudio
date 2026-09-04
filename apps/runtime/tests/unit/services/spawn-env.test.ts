import { describe, expect, it } from 'bun:test';
import { posix, win32 } from 'node:path';
import { buildSpawnEnv, findPathKey, type SpawnEnvFs } from '../../../src/services/spawn-env';

/** In-memory filesystem keyed by exact path strings, so a test controls exactly what "exists". */
class FakeSpawnEnvFs implements SpawnEnvFs {
  readonly #files: Map<string, string>;
  readonly #directories: Map<string, readonly string[]>;

  constructor(
    files: Record<string, string> = {},
    directories: Record<string, readonly string[]> = {}
  ) {
    this.#files = new Map(Object.entries(files));
    this.#directories = new Map(Object.entries(directories));
  }

  readDirectory(path: string): readonly string[] | null {
    return this.#directories.get(path) ?? null;
  }

  exists(path: string): boolean {
    return this.#files.has(path);
  }

  readFile(path: string): string | null {
    return this.#files.get(path) ?? null;
  }
}

const HOME = '/home/tester';

describe('findPathKey', () => {
  it('returns the fallback when it is already the key present', () => {
    expect(findPathKey({ PATH: '/a' }, 'PATH')).toBe('PATH');
  });

  it('finds a differently-cased existing key', () => {
    expect(findPathKey({ Path: '/a' }, 'PATH')).toBe('Path');
  });

  it('returns the fallback when nothing matches', () => {
    expect(findPathKey({ HOME: '/home' }, 'PATH')).toBe('PATH');
  });
});

describe('buildSpawnEnv', () => {
  it('returns a copy of source unchanged when toolchain is absent', () => {
    const source = { PATH: '/usr/bin', HOME };
    const result = buildSpawnEnv({
      source,
      platform: 'linux',
      homeDir: HOME,
      fs: new FakeSpawnEnvFs(),
    });

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });

  it('leaves PATH unchanged when nothing resolves for either runtime', () => {
    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin' },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs: new FakeSpawnEnvFs(),
    });

    expect(result.PATH).toBe('/usr/bin');
    expect(result.NVM_DIR).toBeUndefined();
    expect(result.FNM_DIR).toBeUndefined();
    expect(result.BUN_INSTALL).toBeUndefined();
  });

  it('resolves the nvm default alias and prepends it to an empty inherited PATH', () => {
    const nvmDir = posix.join(HOME, '.nvm');
    const nodeDir = posix.join(nvmDir, 'versions', 'node', 'v22.13.0', 'bin');
    const fs = new FakeSpawnEnvFs({
      [posix.join(nvmDir, 'alias', 'default')]: 'v22.13.0\n',
      [posix.join(nodeDir, 'node')]: 'binary',
    });

    const result = buildSpawnEnv({
      source: { PATH: '' },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs,
    });

    expect(result.PATH).toBe(nodeDir);
    expect(result.NVM_DIR).toBe(nvmDir);
  });

  it('follows an nvm alias chain to the concrete version it resolves to', () => {
    const nvmDir = posix.join(HOME, '.nvm');
    const nodeDir = posix.join(nvmDir, 'versions', 'node', 'v22.13.0', 'bin');
    const fs = new FakeSpawnEnvFs({
      [posix.join(nvmDir, 'alias', 'default')]: 'lts/*',
      [posix.join(nvmDir, 'alias', 'lts', '*')]: 'lts/jod',
      [posix.join(nvmDir, 'alias', 'lts', 'jod')]: 'v22.13.0',
      [posix.join(nodeDir, 'node')]: 'binary',
    });

    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin' },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs,
    });

    expect(result.PATH).toBe(`${nodeDir}:/usr/bin`);
  });

  it('refuses an alias value that walks out of the alias directory', () => {
    const nvmDir = posix.join(HOME, '.nvm');
    const nodeDir = posix.join(nvmDir, 'versions', 'node', 'v22.13.0', 'bin');
    const fs = new FakeSpawnEnvFs({
      [posix.join(nvmDir, 'alias', 'default')]: '../../../../etc/mangostudio-version',
      '/etc/mangostudio-version': 'v22.13.0',
      [posix.join(nodeDir, 'node')]: 'binary',
    });

    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin' },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs,
    });

    expect(result.PATH).toBe('/usr/bin');
  });

  it('resolves the `node` alias to the newest installed version', () => {
    const nvmDir = posix.join(HOME, '.nvm');
    const versions = posix.join(nvmDir, 'versions', 'node');
    const nodeDir = posix.join(versions, 'v24.2.0', 'bin');
    const fs = new FakeSpawnEnvFs(
      {
        [posix.join(nvmDir, 'alias', 'default')]: 'node',
        [posix.join(nodeDir, 'node')]: 'binary',
      },
      { [versions]: ['v20.19.0', 'v24.2.0', 'v22.13.0', '.cache'] }
    );

    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin' },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs,
    });

    expect(result.PATH).toBe(`${nodeDir}:/usr/bin`);
  });

  it('resolves a bare major alias to the newest installed version of that line', () => {
    const nvmDir = posix.join(HOME, '.nvm');
    const versions = posix.join(nvmDir, 'versions', 'node');
    const nodeDir = posix.join(versions, 'v22.13.0', 'bin');
    const fs = new FakeSpawnEnvFs(
      {
        [posix.join(nvmDir, 'alias', 'default')]: '22',
        [posix.join(nodeDir, 'node')]: 'binary',
      },
      { [versions]: ['v22.9.0', 'v24.2.0', 'v22.13.0'] }
    );

    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin' },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs,
    });

    expect(result.PATH).toBe(`${nodeDir}:/usr/bin`);
  });

  it('does not overwrite an already-configured NVM_DIR', () => {
    const nvmDir = '/custom/.nvm';
    const nodeDir = posix.join(nvmDir, 'versions', 'node', 'v20.0.0', 'bin');
    const fs = new FakeSpawnEnvFs({
      [posix.join(nvmDir, 'alias', 'default')]: 'v20.0.0',
      [posix.join(nodeDir, 'node')]: 'binary',
    });

    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin', NVM_DIR: nvmDir },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs,
    });

    expect(result.NVM_DIR).toBe(nvmDir);
    expect(result.PATH).toBe(`${nodeDir}:/usr/bin`);
  });

  it('resolves fnm from FNM_DIR when nvm is not present, without overwriting it', () => {
    const fnmDir = '/custom/fnm';
    const nodeDir = posix.join(fnmDir, 'aliases', 'default', 'bin');
    const fs = new FakeSpawnEnvFs({ [posix.join(nodeDir, 'node')]: 'binary' });

    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin', FNM_DIR: fnmDir },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs,
    });

    expect(result.PATH).toBe(`${nodeDir}:/usr/bin`);
    expect(result.FNM_DIR).toBe(fnmDir);
  });

  it('resolves fnm from the POSIX platform default when FNM_DIR is unset', () => {
    const fnmRoot = posix.join(HOME, '.local', 'share', 'fnm');
    const nodeDir = posix.join(fnmRoot, 'aliases', 'default', 'bin');
    const fs = new FakeSpawnEnvFs({ [posix.join(nodeDir, 'node')]: 'binary' });

    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin' },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs,
    });

    expect(result.PATH).toBe(`${nodeDir}:/usr/bin`);
    expect(result.FNM_DIR).toBe(fnmRoot);
  });

  it('resolves fnm from the macOS platform default, not the XDG one', () => {
    const fnmRoot = posix.join('/Users/tester', 'Library', 'Application Support', 'fnm');
    const nodeDir = posix.join(fnmRoot, 'aliases', 'default', 'bin');
    const fs = new FakeSpawnEnvFs({
      [posix.join(nodeDir, 'node')]: 'binary',
      '/opt/homebrew/bin/node': 'binary',
    });

    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin' },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'darwin',
      homeDir: '/Users/tester',
      fs,
    });

    expect(result.PATH).toBe(`${nodeDir}:/usr/bin`);
    expect(result.FNM_DIR).toBe(fnmRoot);
  });

  it('keeps a single PATH key on win32 when the inherited env spells it PATH', () => {
    const nodeDir = 'C:\\Program Files\\nodejs';
    const fs = new FakeSpawnEnvFs({ [win32.join(nodeDir, 'node.exe')]: 'binary' });

    const result = buildSpawnEnv({
      source: { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      fs,
    });

    expect(Object.keys(result).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(result.PATH).toBe(`${nodeDir};C:\\Windows`);
  });

  it('resolves fnm from the win32 platform default (%APPDATA%\\fnm) when FNM_DIR is unset', () => {
    const appData = 'C:\\Users\\tester\\AppData\\Roaming';
    const fnmRoot = win32.join(appData, 'fnm');
    const nodeDir = win32.join(fnmRoot, 'aliases', 'default');
    const fs = new FakeSpawnEnvFs({ [win32.join(nodeDir, 'node.exe')]: 'binary' });

    const result = buildSpawnEnv({
      source: { Path: '', APPDATA: appData },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      fs,
    });

    expect(result.Path).toBe(nodeDir);
    expect(result.FNM_DIR).toBe(fnmRoot);
    expect(Object.keys(result).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path']);
  });

  it('falls back to the well-known Program Files node dir on win32 with an empty inherited Path', () => {
    const programFiles = 'C:\\Program Files';
    const nodeDir = win32.join(programFiles, 'nodejs');
    const fs = new FakeSpawnEnvFs({ [win32.join(nodeDir, 'node.exe')]: 'binary' });

    const result = buildSpawnEnv({
      source: { Path: '', ProgramFiles: programFiles },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      fs,
    });

    expect(result.Path).toBe(nodeDir);
    expect(Object.keys(result).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path']);
  });

  it('uses dirname of an explicit path choice without checking existence', () => {
    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin' },
      toolchain: { node: '/opt/custom/node/bin/node', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs: new FakeSpawnEnvFs(),
    });

    expect(result.PATH).toBe('/opt/custom/node/bin:/usr/bin');
  });

  it('orders an explicit node dir before an explicit bun dir', () => {
    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin' },
      toolchain: { node: '/opt/node/bin/node', bun: '/opt/bun/bin/bun' },
      platform: 'linux',
      homeDir: HOME,
      fs: new FakeSpawnEnvFs(),
    });

    expect(result.PATH).toBe('/opt/node/bin:/opt/bun/bin:/usr/bin');
  });

  it('resolves bun auto from BUN_INSTALL, without overwriting it', () => {
    const bunInstall = '/custom/bun';
    const bunBinDir = posix.join(bunInstall, 'bin');
    const fs = new FakeSpawnEnvFs({ [posix.join(bunBinDir, 'bun')]: 'binary' });

    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin', BUN_INSTALL: bunInstall },
      toolchain: { node: '/opt/node/bin/node', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs,
    });

    expect(result.PATH).toBe(`/opt/node/bin:${bunBinDir}:/usr/bin`);
    expect(result.BUN_INSTALL).toBe(bunInstall);
  });

  it('resolves bun auto from ~/.bun when BUN_INSTALL is unset, and sets it', () => {
    const bunRoot = posix.join(HOME, '.bun');
    const bunBinDir = posix.join(bunRoot, 'bin');
    const fs = new FakeSpawnEnvFs({ [posix.join(bunBinDir, 'bun')]: 'binary' });

    const result = buildSpawnEnv({
      source: { PATH: '/usr/bin' },
      toolchain: { node: 'auto', bun: 'auto' },
      platform: 'linux',
      homeDir: HOME,
      fs,
    });

    expect(result.PATH).toBe(`${bunBinDir}:/usr/bin`);
    expect(result.BUN_INSTALL).toBe(bunRoot);
  });
});
