import { describe, expect, it } from 'bun:test';
import { type DetachDeps, spawnDetached } from '../../../src/cli/detach';
import type { ServerState } from '../../../src/lib/server-state';
import { FakeProcessController } from '../../support/mocks/fake-process-controller';

const CHILD_PID = 100;

function makeState(): ServerState {
  return {
    pid: CHILD_PID,
    port: 3001,
    host: 'localhost',
    startedAt: 0,
    logFile: 'server.log',
    version: 'test',
  };
}

function baseDeps(overrides: Partial<DetachDeps> = {}): Partial<DetachDeps> {
  let now = 0;
  return {
    controller: new FakeProcessController([CHILD_PID]),
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    spawn: () => CHILD_PID,
    readState: () => Promise.resolve(makeState()),
    confirmsHealthy: () => Promise.resolve(true),
    ...overrides,
  };
}

describe('spawnDetached', () => {
  it('resolves with the child pid once it is healthy', async () => {
    let spawnedPort = 0;
    let spawnedHost = '';
    const result = await spawnDetached(3001, 'localhost', {
      ...baseDeps(),
      spawn: (port, host) => {
        spawnedPort = port;
        spawnedHost = host;
        return CHILD_PID;
      },
    });

    expect(result.pid).toBe(CHILD_PID);
    expect(result.port).toBe(3001);
    expect(result.logFile).toMatch(/server-\d{8}-\d{6}\.log$/);
    expect(spawnedPort).toBe(3001);
    expect(spawnedHost).toBe('localhost');
  });

  it('fails fast when the child dies during startup', async () => {
    const deps = baseDeps({ controller: new FakeProcessController([]) });

    await expect(spawnDetached(3001, 'localhost', deps)).rejects.toThrow(/failed to start/i);
  });

  it('fails when the child never becomes healthy', async () => {
    const deps = baseDeps({ confirmsHealthy: () => Promise.resolve(false) });

    await expect(spawnDetached(3001, 'localhost', deps)).rejects.toThrow(/did not become healthy/i);
  });
});
