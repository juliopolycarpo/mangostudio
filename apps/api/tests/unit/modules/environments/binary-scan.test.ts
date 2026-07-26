import { describe, expect, it } from 'bun:test';
import {
  type BinaryScanDeps,
  scanRuntime,
} from '../../../../src/modules/environments/domain/binary-scan';
import {
  BUN_RUNTIME_DEFINITION,
  NODE_RUNTIME_DEFINITION,
  parseBunVersion,
  parseNodeVersion,
} from '../../../../src/modules/environments/domain/runtime-definitions';

function fakeDeps(overrides: Partial<BinaryScanDeps> = {}): BinaryScanDeps {
  return {
    platform: 'linux',
    homeDir: '/home/tester',
    env: { PATH: '' },
    pathExists: () => false,
    probeVersion: () => Promise.resolve(null),
    realpath: (path) => Promise.resolve(path),
    ...overrides,
  };
}

describe('scanRuntime', () => {
  it('returns every working PATH installation in shell resolution order', async () => {
    const versions: Record<string, string> = {
      '/first/bin/node': 'v20.11.0',
      '/second/bin/node': 'v22.13.0',
    };

    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        env: { PATH: '/first/bin:/second/bin' },
        pathExists: (path) => path in versions,
        probeVersion: (binary) => Promise.resolve(versions[binary] ?? null),
      })
    );

    expect(result.installations).toEqual([
      {
        path: '/first/bin/node',
        rawPath: '/first/bin/node',
        version: 'v20.11.0',
        origin: 'path',
        pathIndex: 0,
        effective: true,
      },
      {
        path: '/second/bin/node',
        rawPath: '/second/bin/node',
        version: 'v22.13.0',
        origin: 'path',
        pathIndex: 1,
        effective: false,
      },
    ]);
  });

  it('marks later paths to the same executable as aliases', async () => {
    const aliases = new Set(['/usr/local/bin/node', '/home/tester/.nvm/current/bin/node']);

    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        env: { PATH: '/usr/local/bin:/home/tester/.nvm/current/bin' },
        pathExists: (path) => aliases.has(path),
        probeVersion: (path) => Promise.resolve(aliases.has(path) ? 'v22.13.0' : null),
        realpath: () => Promise.resolve('/home/tester/.nvm/versions/node/v22.13.0/bin/node'),
      })
    );

    expect(result.installations).toHaveLength(2);
    expect(result.installations[0]).not.toHaveProperty('aliasOf');
    expect(result.installations[1]).toMatchObject({
      rawPath: '/home/tester/.nvm/current/bin/node',
      aliasOf: '/usr/local/bin/node',
      effective: false,
    });
  });

  it('probes independent candidates concurrently without changing result order', async () => {
    const started: string[] = [];
    const resolvers = new Map<string, (version: string) => void>();
    const definition = {
      ...NODE_RUNTIME_DEFINITION,
      wellKnownDirs: () => [],
      includeBareBinaryNames: false,
    };

    const scan = scanRuntime(
      definition,
      fakeDeps({
        env: { PATH: '/first/bin:/second/bin' },
        pathExists: () => true,
        probeVersion: (binary) =>
          new Promise((resolve) => {
            started.push(binary);
            resolvers.set(binary, resolve);
          }),
      })
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['/first/bin/node', '/second/bin/node']);

    resolvers.get('/second/bin/node')?.('v22.13.0');
    resolvers.get('/first/bin/node')?.('v20.11.0');
    const result = await scan;

    expect(result.installations.map((installation) => installation.rawPath)).toEqual([
      '/first/bin/node',
      '/second/bin/node',
    ]);
  });

  it('returns partial results with a timeout failure instead of hanging', async () => {
    const definition = {
      ...NODE_RUNTIME_DEFINITION,
      wellKnownDirs: () => [],
      includeBareBinaryNames: false,
    };

    const result = await scanRuntime(
      definition,
      fakeDeps({
        env: { PATH: '/fast/bin:/stalled/bin' },
        pathExists: () => true,
        probeVersion: (binary) =>
          binary === '/fast/bin/node' ? Promise.resolve('v22.13.0') : new Promise(() => undefined),
        totalTimeoutMs: 20,
      })
    );

    expect(result.installations.map((installation) => installation.rawPath)).toEqual([
      '/fast/bin/node',
    ]);
    expect(result.failures).toContainEqual({
      code: 'probe-timeout',
      path: '/stalled/bin/node',
    });
  }, 250);

  it('identifies PATH installations owned by a version manager', async () => {
    const nodePath = '/home/tester/.volta/bin/node';

    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        env: { PATH: '/home/tester/.volta/bin' },
        pathExists: (path) => path === nodePath,
        probeVersion: (path) => Promise.resolve(path === nodePath ? 'v22.13.0' : null),
      })
    );

    expect(result.installations[0]).toMatchObject({
      rawPath: nodePath,
      origin: 'version-manager',
      managedBy: 'volta',
      pathIndex: 0,
    });
  });

  it('identifies nvm installations under a custom NVM_DIR', async () => {
    const nodePath = '/opt/custom-nvm/versions/node/v24.18.0/bin/node';

    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        env: {
          PATH: '/opt/custom-nvm/versions/node/v24.18.0/bin',
          NVM_DIR: '/opt/custom-nvm',
        },
        pathExists: (path) => path === nodePath,
        probeVersion: (path) => Promise.resolve(path === nodePath ? 'v24.18.0' : null),
      })
    );

    expect(result.installations[0]).toMatchObject({
      rawPath: nodePath,
      origin: 'version-manager',
      managedBy: 'nvm',
    });
  });

  it('treats an authoritative configured binary as the only candidate', async () => {
    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        env: { PATH: '/path/bin' },
        configuredPath: '/opt/custom/node',
        configuredOnly: true,
        pathExists: (path) => path === '/path/bin/node',
        probeVersion: () => Promise.resolve('v22.13.0'),
      })
    );

    expect(result.installations).toEqual([
      {
        path: '/opt/custom/node',
        rawPath: '/opt/custom/node',
        version: 'v22.13.0',
        origin: 'configured',
        effective: true,
      },
    ]);
  });

  it('reports an existing binary that cannot return a valid version', async () => {
    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        env: { PATH: '/broken/bin' },
        pathExists: (path) => path === '/broken/bin/node',
        probeVersion: () => Promise.resolve(null),
      })
    );

    expect(result.installations).toEqual([]);
    expect(result.failures).toContainEqual({
      code: 'not-executable',
      path: '/broken/bin/node',
    });
  });

  it('classifies a Bun hit outside PATH as well-known', async () => {
    const bunPath = '/home/tester/.bun/bin/bun';
    const result = await scanRuntime(
      BUN_RUNTIME_DEFINITION,
      fakeDeps({
        pathExists: (path) => path === bunPath,
        probeVersion: (path) => Promise.resolve(path === bunPath ? '1.2.3' : null),
      })
    );

    expect(result.installations[0]).toEqual({
      path: bunPath,
      rawPath: bunPath,
      version: '1.2.3',
      origin: 'well-known',
      effective: true,
    });
  });

  it('honors Windows PATHEXT order when locating command shims', async () => {
    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        platform: 'win32',
        env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        pathExists: (path) => path === 'C:\\tools\\node.cmd',
        probeVersion: (path) => Promise.resolve(path.endsWith('node.cmd') ? 'v22.13.0' : null),
      })
    );

    expect(result.installations[0]?.rawPath).toBe('C:\\tools\\node.cmd');
  });

  it('stops probing once stopWhen accepts a candidate', async () => {
    const versions: Record<string, string> = {
      '/a/bin/node': 'v20.11.0',
      '/b/bin/node': 'v22.13.0',
      '/c/bin/node': 'v24.0.0',
    };
    const probed: string[] = [];

    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        env: { PATH: '/a/bin:/b/bin:/c/bin' },
        maxConcurrency: 1,
        pathExists: (path) => path in versions,
        probeVersion: (binary) => {
          probed.push(binary);
          return Promise.resolve(versions[binary] ?? null);
        },
        stopWhen: (version) => version === 'v22.13.0',
      })
    );

    expect(probed).toEqual(['/a/bin/node', '/b/bin/node']);
    expect(result.installations.map((installation) => installation.rawPath)).toEqual([
      '/a/bin/node',
      '/b/bin/node',
    ]);
    expect(result.installations[0]?.effective).toBe(true);
  });

  it('keeps scanning every candidate when stopWhen is absent', async () => {
    const versions: Record<string, string> = {
      '/a/bin/node': 'v20.11.0',
      '/b/bin/node': 'v22.13.0',
      '/c/bin/node': 'v24.0.0',
    };
    const probed: string[] = [];

    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        env: { PATH: '/a/bin:/b/bin:/c/bin' },
        maxConcurrency: 1,
        pathExists: (path) => path in versions,
        probeVersion: (binary) => {
          probed.push(binary);
          return Promise.resolve(versions[binary] ?? null);
        },
      })
    );

    expect(probed).toHaveLength(3);
    expect(result.installations).toHaveLength(3);
  });
});

describe('runtime version parsing', () => {
  it('accepts Node and Bun output formats and rejects garbage', () => {
    expect(parseNodeVersion('v22.13.0')).toEqual({ major: 22, minor: 13, patch: 0 });
    expect(parseBunVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseNodeVersion('not a version')).toBeNull();
    expect(parseBunVersion('v1.2.3')).toBeNull();
  });
});
