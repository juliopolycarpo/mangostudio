import { describe, expect, it } from 'bun:test';
import { type RestartDeps, runRestart } from '../../../../src/cli/commands/restart';
import { confirmsHealthy } from '../../../../src/cli/health';
import type { ServerState } from '../../../../src/lib/server-state';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';
import {
  FakeServiceManager,
  installedAndRunning,
} from '../../../support/mocks/fake-service-manager';

const DETACHED: ServerState = {
  pid: 42,
  port: 3001,
  host: '0.0.0.0',
  startedAt: 0,
  logFile: '/home/test/.mango/logs/server-1.log',
  version: 't',
};
const SERVICE: ServerState = { ...DETACHED, service: 'mangostudio.service' };
const FOREGROUND: ServerState = { ...DETACHED, logFile: '' };

const noop = (): Promise<void> => Promise.resolve();

function baseDeps(overrides: Partial<RestartDeps> = {}) {
  const lines: string[] = [];
  const manager = new FakeServiceManager();
  let now = 0;
  const deps: Partial<RestartDeps> = {
    manager,
    controller: new FakeProcessController(),
    readState: () => Promise.resolve(null),
    removeState: noop,
    spawnDetached: () => Promise.resolve({ pid: 43, port: 3001, logFile: '/x.log' }),
    confirmsHealthy: () => Promise.resolve(true),
    log: (msg) => lines.push(msg),
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, lines, manager };
}

describe('runRestart', () => {
  it('stops a detached instance and respawns it waiting on the old pid', async () => {
    const controller = new FakeProcessController([42]);
    const spawned: unknown[] = [];
    const { deps, lines } = baseDeps({
      controller,
      readState: () => Promise.resolve(DETACHED),
      sleep: () => {
        controller.die(42);
        return Promise.resolve();
      },
      spawnDetached: (port, host, _deps, options) => {
        spawned.push([port, host, options]);
        return Promise.resolve({ pid: 43, port, logFile: '/x.log' });
      },
    });
    await runRestart(deps);
    expect(controller.terminated).toEqual([42]);
    expect(spawned).toEqual([[3001, '0.0.0.0', { waitForPid: 42 }]]);
    expect(lines[0]).toBe('MangoStudio restarted (PID 43, http://localhost:3001).');
  });

  it('bounces a service-managed instance through the supervisor and waits for the successor', async () => {
    const controller = new FakeProcessController([42]);
    let reads = 0;
    const { deps, lines, manager } = baseDeps({
      controller,
      readState: () => {
        reads += 1;
        if (reads < 3) return Promise.resolve(SERVICE);
        controller.die(42);
        return Promise.resolve({ ...SERVICE, pid: 77 });
      },
    });
    controller.die(77);
    const alive = new FakeProcessController([42, 77]);
    deps.controller = alive;
    await runRestart(deps);
    expect(manager.calls).toEqual(['restart']);
    expect(lines).toEqual([
      'Restart requested through mangostudio.service.',
      'MangoStudio restarted (PID 77, http://localhost:3001).',
    ]);
  });

  it('refuses a foreground instance and says where to restart it', async () => {
    const { deps } = baseDeps({
      controller: new FakeProcessController([42]),
      readState: () => Promise.resolve(FOREGROUND),
    });
    await expect(runRestart(deps)).rejects.toThrow(/started in the foreground \(PID 42\)/);
  });

  it('starts the installed service when nothing is running', async () => {
    const { deps, lines, manager } = baseDeps({
      controller: new FakeProcessController([77]),
      readState: () => Promise.resolve({ ...SERVICE, pid: 77 }),
    });
    manager.setStatus({ ...installedAndRunning(), running: false });
    let first = true;
    deps.readState = () => {
      if (first) {
        first = false;
        return Promise.resolve(null);
      }
      return Promise.resolve({ ...SERVICE, pid: 77 });
    };
    await runRestart(deps);
    expect(manager.calls).toEqual(['status', 'start']);
    expect(lines[0]).toContain('started through mangostudio.service (PID 77');
  });

  it('explains what to do when nothing runs and no service is installed', async () => {
    const { deps } = baseDeps();
    await expect(runRestart(deps)).rejects.toThrow(/No running instance to restart/);
  });

  it('gives up when the successor never becomes healthy', async () => {
    const { deps } = baseDeps({
      controller: new FakeProcessController([42]),
      readState: () => Promise.resolve(SERVICE),
    });
    await expect(runRestart(deps)).rejects.toThrow(/did not come back within 20s/);
  });

  it('accepts a LAN-bound successor the health probe cannot reach', async () => {
    const LAN = { ...SERVICE, host: '192.168.1.20' };
    const controller = new FakeProcessController([42, 77]);
    let reads = 0;
    const { deps, lines } = baseDeps({
      controller,
      readState: () => {
        reads += 1;
        if (reads < 3) return Promise.resolve(LAN);
        controller.die(42);
        return Promise.resolve({ ...LAN, pid: 77 });
      },
      // The real one, not a stub: `probeHealth` answers `false` for a host that
      // is neither loopback nor bind-all — it refuses to fetch it rather than
      // measuring anything — so gating on it burned the whole budget on a
      // successor that was serving fine. `confirmsHealthy` is what knows the
      // difference, and returns here without touching the network.
      confirmsHealthy,
    });

    await runRestart(deps);

    expect(lines.at(-1)).toContain('PID 77');
  });
});
