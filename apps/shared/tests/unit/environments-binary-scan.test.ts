import { describe, expect, it } from 'bun:test';
import {
  type BinaryScanDeps,
  BUN_RUNTIME_DEFINITION,
  CURSOR_AGENT_CLI_DEFINITION,
  NODE_RUNTIME_DEFINITION,
  parseBunVersion,
  parseNodeVersion,
  scanRuntime,
} from '@mangostudio/shared/environments/detection';

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
        pathSource: 'system',
      },
      {
        path: '/second/bin/node',
        rawPath: '/second/bin/node',
        version: 'v22.13.0',
        origin: 'path',
        pathIndex: 1,
        effective: false,
        pathSource: 'system',
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
      effective: true,
      pathSource: 'volta',
    });
  });

  it('classifies a win32 fnm Node under the default %APPDATA%\\fnm alias with no FNM_DIR set', async () => {
    const nodePath = 'C:\\Users\\x\\AppData\\Roaming\\fnm\\aliases\\default\\node.exe';

    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        platform: 'win32',
        homeDir: 'C:\\Users\\x',
        env: { PATH: '', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
        pathExists: (path) => path === nodePath,
        probeVersion: (path) => Promise.resolve(path === nodePath ? 'v24.9.0' : null),
      })
    );

    expect(result.installations[0]).toMatchObject({
      rawPath: nodePath,
      managedBy: 'fnm',
      pathSource: 'fnm',
    });
  });

  it('still classifies fnm on win32 when FNM_DIR points somewhere else', async () => {
    const nodePath = 'D:\\tools\\fnm\\aliases\\default\\node.exe';

    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        platform: 'win32',
        homeDir: 'C:\\Users\\x',
        env: { PATH: '', FNM_DIR: 'D:\\tools\\fnm' },
        pathExists: (path) => path === nodePath,
        probeVersion: (path) => Promise.resolve(path === nodePath ? 'v24.9.0' : null),
      })
    );

    expect(result.installations[0]).toMatchObject({
      rawPath: nodePath,
      managedBy: 'fnm',
      pathSource: 'fnm',
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
      pathSource: 'nvm',
    });
  });

  it('attributes a plain system install to no version manager or Bun install', async () => {
    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        env: { PATH: '/usr/bin' },
        pathExists: (path) => path === '/usr/bin/node',
        probeVersion: (path) => Promise.resolve(path === '/usr/bin/node' ? 'v22.13.0' : null),
      })
    );

    expect(result.installations[0]).toMatchObject({
      rawPath: '/usr/bin/node',
      pathSource: 'system',
    });
    expect(result.installations[0]).not.toHaveProperty('managedBy');
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
        effective: false,
        pathSource: 'system',
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

  it('keeps a Bun installation found only outside PATH ineffective', async () => {
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
      effective: false,
      pathSource: 'bun',
    });
  });

  it('attributes a Bun install under a custom BUN_INSTALL to bun', async () => {
    const bunPath = '/opt/bun-custom/bin/bun';
    const result = await scanRuntime(
      BUN_RUNTIME_DEFINITION,
      fakeDeps({
        env: { PATH: '', BUN_INSTALL: '/opt/bun-custom' },
        pathExists: (path) => path === bunPath,
        probeVersion: (path) => Promise.resolve(path === bunPath ? '1.2.3' : null),
      })
    );

    expect(result.installations[0]).toMatchObject({ rawPath: bunPath, pathSource: 'bun' });
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

  it('finds Cursor under its renamed `agent` binary before the legacy `cursor-agent`', async () => {
    const result = await scanRuntime(
      CURSOR_AGENT_CLI_DEFINITION.runtime,
      fakeDeps({
        env: { PATH: '/usr/local/bin' },
        pathExists: (path) => path === '/usr/local/bin/agent',
        probeVersion: (path) =>
          Promise.resolve(path === '/usr/local/bin/agent' ? '2026.07.16-899851b' : null),
      })
    );

    expect(result.installations.map((installation) => installation.rawPath)).toEqual([
      '/usr/local/bin/agent',
    ]);
  });

  it('still finds a pre-rename Cursor install under the legacy `cursor-agent` name', async () => {
    const result = await scanRuntime(
      CURSOR_AGENT_CLI_DEFINITION.runtime,
      fakeDeps({
        env: { PATH: '/usr/local/bin' },
        pathExists: (path) => path === '/usr/local/bin/cursor-agent',
        probeVersion: (path) =>
          Promise.resolve(path === '/usr/local/bin/cursor-agent' ? '2026.07.16-899851b' : null),
      })
    );

    expect(result.installations.map((installation) => installation.rawPath)).toEqual([
      '/usr/local/bin/cursor-agent',
    ]);
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

describe('probe budget by platform', () => {
  /**
   * Measured on a real install: `cursor-agent --version` answers in ~2.1s on
   * Windows, where `PATH` holds a `.cmd` shim that starts a runtime that loads
   * a bundled script, against well under a second for the same version on
   * Linux. At the POSIX budget the shim was killed mid-answer and a working,
   * signed-in CLI was reported as not installed.
   */
  const WINDOWS_SHIM_ANSWER_MS = 2_100;

  function slowProbe(afterMs: number) {
    return (_path: string, _args: readonly string[], timeoutMs: number) =>
      new Promise<string | null>((resolve) => {
        // Stands in for a child killed at its own deadline.
        setTimeout(() => resolve(afterMs <= timeoutMs ? 'v22.13.0' : null), 0);
      });
  }

  it('gives a Windows shim long enough to answer', async () => {
    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        platform: 'win32',
        env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        pathExists: (path) => path === 'C:\\tools\\node.cmd',
        probeVersion: slowProbe(WINDOWS_SHIM_ANSWER_MS),
      })
    );

    expect(result.installations.map((install) => install.path)).toEqual(['C:\\tools\\node.cmd']);
  });

  it('keeps the tighter budget where the binary is native', async () => {
    const result = await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        env: { PATH: '/usr/bin' },
        pathExists: (path) => path === '/usr/bin/node',
        probeVersion: slowProbe(WINDOWS_SHIM_ANSWER_MS),
      })
    );

    expect(result.installations).toEqual([]);
  });

  it('lets an explicit budget override the platform default', async () => {
    const seen: number[] = [];
    await scanRuntime(
      NODE_RUNTIME_DEFINITION,
      fakeDeps({
        platform: 'win32',
        env: { PATH: 'C:\\tools', PATHEXT: '.CMD' },
        pathExists: (path) => path === 'C:\\tools\\node.cmd',
        probeTimeoutMs: 750,
        probeVersion: (_path, _args, timeoutMs) => {
          seen.push(timeoutMs);
          return Promise.resolve('v22.13.0');
        },
      })
    );

    expect(seen).toEqual([750]);
  });
});
