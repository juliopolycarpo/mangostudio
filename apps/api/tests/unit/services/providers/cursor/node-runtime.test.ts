import { afterEach, describe, expect, it } from 'bun:test';
import { win32 } from 'node:path';
import {
  detectNodeRuntime,
  type NodeRuntimeProbeDeps,
  nodeBinaryCandidateNames,
  probeNodeRuntime,
  resetNodeRuntimeCache,
  wellKnownNodeDirectories,
} from '../../../../../src/services/providers/cursor/node-runtime';

function fakeDeps(overrides: Partial<NodeRuntimeProbeDeps> = {}): Partial<NodeRuntimeProbeDeps> {
  return {
    platform: 'linux',
    env: { PATH: '' },
    homeDir: '/home/tester',
    configuredNodePath: '',
    pathExists: () => false,
    probeVersion: () => Promise.resolve(null),
    ...overrides,
  };
}

describe('cursor node runtime detector', () => {
  afterEach(() => {
    resetNodeRuntimeCache();
  });

  it('reports availability when node meets the minimum version', async () => {
    const status = await detectNodeRuntime({ force: true });
    expect(typeof status.available).toBe('boolean');
    if (status.available) {
      expect(status.nodePath).toBeTruthy();
      expect(status.version).toMatch(/^v?\d+\.\d+\.\d+/);
    } else {
      expect(status.reasonCode).toBeTruthy();
    }
  });

  it('caches repeated probes within the TTL window', async () => {
    const first = await detectNodeRuntime({ force: true });
    const second = await detectNodeRuntime();
    expect(second).toEqual(first);
  });
});

describe('probeNodeRuntime resolution order', () => {
  it('uses the configured node path before any PATH lookup', async () => {
    const probed: string[] = [];
    const status = await probeNodeRuntime(
      fakeDeps({
        configuredNodePath: '/opt/custom/node',
        env: { PATH: '/usr/bin' },
        pathExists: (path) => path === '/usr/bin/node',
        probeVersion: (binary) => {
          probed.push(binary);
          return Promise.resolve('v23.1.0');
        },
      })
    );

    expect(status).toEqual({ available: true, nodePath: '/opt/custom/node', version: 'v23.1.0' });
    expect(probed).toEqual(['/opt/custom/node']);
  });

  it('reports node_invalid without fallback when the configured path fails the probe', async () => {
    const status = await probeNodeRuntime(
      fakeDeps({
        configuredNodePath: '/opt/broken/node',
        env: { PATH: '/usr/bin' },
        pathExists: (path) => path === '/usr/bin/node',
        probeVersion: (binary) => Promise.resolve(binary === '/opt/broken/node' ? null : 'v23.1.0'),
      })
    );

    expect(status.available).toBe(false);
    expect(status.reasonCode).toBe('cursor.node_invalid');
    expect(status.reasonParams).toEqual({ nodePath: '/opt/broken/node' });
  });

  it('reports version_insufficient for a configured path running old Node', async () => {
    const status = await probeNodeRuntime(
      fakeDeps({
        configuredNodePath: '/opt/old/node',
        probeVersion: () => Promise.resolve('v20.11.0'),
      })
    );

    expect(status.reasonCode).toBe('cursor.version_insufficient');
    expect(status.reasonParams).toEqual({ foundVersion: 'v20.11.0' });
  });

  it('resolves node from PATH entries in order', async () => {
    const status = await probeNodeRuntime(
      fakeDeps({
        env: { PATH: '/first/bin:/second/bin' },
        pathExists: (path) => path === '/second/bin/node',
        probeVersion: (binary) =>
          Promise.resolve(binary === '/second/bin/node' ? 'v22.13.0' : null),
      })
    );

    expect(status).toEqual({ available: true, nodePath: '/second/bin/node', version: 'v22.13.0' });
  });

  it('skips a PATH entry whose node exists but fails the version probe', async () => {
    const status = await probeNodeRuntime(
      fakeDeps({
        env: { PATH: '/broken/bin:/good/bin' },
        pathExists: (path) => path === '/broken/bin/node' || path === '/good/bin/node',
        probeVersion: (binary) => Promise.resolve(binary === '/good/bin/node' ? 'v22.14.1' : null),
      })
    );

    expect(status).toEqual({ available: true, nodePath: '/good/bin/node', version: 'v22.14.1' });
  });

  it('falls back to well-known install directories when PATH has no node', async () => {
    const voltaNode = '/home/tester/.volta/bin/node';
    const status = await probeNodeRuntime(
      fakeDeps({
        env: { PATH: '/usr/bin' },
        pathExists: (path) => path === voltaNode,
        probeVersion: (binary) => Promise.resolve(binary === voltaNode ? 'v24.0.0' : null),
      })
    );

    expect(status).toEqual({ available: true, nodePath: voltaNode, version: 'v24.0.0' });
  });

  it('keeps scanning past an old install and reports it only when nothing newer exists', async () => {
    const versions: Record<string, string> = {
      '/first/bin/node': 'v18.19.0',
      '/second/bin/node': 'v22.13.0',
    };
    const found = await probeNodeRuntime(
      fakeDeps({
        env: { PATH: '/first/bin:/second/bin' },
        pathExists: (path) => path in versions,
        probeVersion: (binary) => Promise.resolve(versions[binary] ?? null),
      })
    );
    expect(found).toEqual({ available: true, nodePath: '/second/bin/node', version: 'v22.13.0' });

    const onlyOld = await probeNodeRuntime(
      fakeDeps({
        env: { PATH: '/first/bin' },
        pathExists: (path) => path === '/first/bin/node',
        probeVersion: (binary) => Promise.resolve(binary === '/first/bin/node' ? 'v18.19.0' : null),
      })
    );
    expect(onlyOld.available).toBe(false);
    expect(onlyOld.reasonCode).toBe('cursor.version_insufficient');
    expect(onlyOld.reasonParams).toEqual({ foundVersion: 'v18.19.0' });
  });

  it('falls back to a bare binary name resolved by the OS as a last resort', async () => {
    const status = await probeNodeRuntime(
      fakeDeps({
        env: { PATH: '/usr/bin' },
        probeVersion: (binary) => Promise.resolve(binary === 'node' ? 'v22.13.0' : null),
      })
    );

    expect(status).toEqual({ available: true, nodePath: 'node', version: 'v22.13.0' });
  });

  it('reports node_not_found when no candidate probes successfully', async () => {
    const status = await probeNodeRuntime(fakeDeps({ env: { PATH: '/usr/bin:/usr/local/bin' } }));

    expect(status).toEqual({ available: false, reasonCode: 'cursor.node_not_found' });
  });
});

describe('nodeBinaryCandidateNames', () => {
  it('returns only "node" on POSIX platforms', () => {
    expect(nodeBinaryCandidateNames({ platform: 'linux', env: {} })).toEqual(['node']);
    expect(nodeBinaryCandidateNames({ platform: 'darwin', env: {} })).toEqual(['node']);
  });

  it('honors PATHEXT order on Windows, including .cmd shims', () => {
    const names = nodeBinaryCandidateNames({
      platform: 'win32',
      env: { PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' },
    });
    expect(names).toEqual(['node.com', 'node.exe', 'node.bat', 'node.cmd', 'node']);
  });

  it('uses an executable-extension fallback when PATHEXT is unset', () => {
    const names = nodeBinaryCandidateNames({ platform: 'win32', env: {} });
    expect(names).toEqual(['node.exe', 'node.cmd', 'node.bat', 'node.com', 'node']);
  });
});

describe('wellKnownNodeDirectories', () => {
  it('lists bounded POSIX install locations', () => {
    const dirs = wellKnownNodeDirectories({ platform: 'darwin', env: {}, homeDir: '/Users/dev' });
    expect(dirs).toEqual([
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/Users/dev/.volta/bin',
      '/Users/dev/.local/share/fnm/aliases/default/bin',
    ]);
  });

  it('lists Windows locations only for env vars that are present', () => {
    const dirs = wellKnownNodeDirectories({
      platform: 'win32',
      env: {
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        NVM_SYMLINK: 'C:\\nvm\\current',
      },
      homeDir: 'C:\\Users\\dev',
    });

    expect(dirs[0]).toBe('C:\\nvm\\current');
    expect(dirs).toContain(win32.join('C:\\Program Files', 'nodejs'));
    expect(dirs).toContain(win32.join('C:\\Users\\dev\\AppData\\Local', 'Programs', 'nodejs'));
    expect(dirs.some((dir) => dir.toLowerCase().includes('volta'))).toBe(false);
  });
});
