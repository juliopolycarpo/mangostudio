import { afterEach, describe, expect, it } from 'bun:test';
import { runServe } from '../../../../src/cli/commands/serve';
import { resetConfig } from '../../../../src/lib/config';
import type { ServerState } from '../../../../src/lib/server-state';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';

const STATE: ServerState = {
  pid: 42,
  port: 3001,
  host: 'localhost',
  startedAt: 0,
  logFile: '',
  version: 't',
};

const noop = (): Promise<void> => Promise.resolve();

// runServe (detached branch) reads getConfig() for the host; reset the singleton
// afterwards so it cannot leak into config-sensitive tests.
afterEach(() => {
  resetConfig();
});

describe('runServe (detached)', () => {
  it('refuses to start when a live instance already exists', async () => {
    const refuse = runServe(
      { port: 3000, detached: true },
      {
        readState: () => Promise.resolve(STATE),
        removeState: noop,
        controller: new FakeProcessController([42]),
        spawnDetached: () => Promise.resolve({ pid: 1, port: 3000, logFile: '/l.log' }),
        log: () => undefined,
      }
    );

    await expect(refuse).rejects.toThrow(/already running/i);
  });

  it('clears a stale state file and spawns the detached server', async () => {
    let removed = false;
    let spawnedPort = 0;
    const lines: string[] = [];

    await runServe(
      { port: 3000, detached: true },
      {
        readState: () => Promise.resolve(STATE),
        removeState: () => {
          removed = true;
          return Promise.resolve();
        },
        controller: new FakeProcessController([]), // pid 42 is dead → stale
        spawnDetached: (port) => {
          spawnedPort = port;
          return Promise.resolve({ pid: 99, port, logFile: '/l.log' });
        },
        log: (msg) => lines.push(msg),
      }
    );

    expect(removed).toBe(true);
    expect(spawnedPort).toBe(3000);
    expect(lines.join('\n')).toContain('MangoStudio started (PID 99, port 3000).');
    expect(lines.join('\n')).toContain('Logs: /l.log');
  });

  it('spawns directly when no instance exists', async () => {
    let spawnedPort = 0;
    const lines: string[] = [];

    await runServe(
      { port: 3000, detached: true },
      {
        readState: () => Promise.resolve(null),
        controller: new FakeProcessController(),
        spawnDetached: (port) => {
          spawnedPort = port;
          return Promise.resolve({ pid: 7, port, logFile: '/l.log' });
        },
        log: (msg) => lines.push(msg),
      }
    );

    expect(spawnedPort).toBe(3000);
    expect(lines.join('\n')).toContain('PID 7');
  });

  it('rejects an invalid port before touching state', async () => {
    let readCalled = false;

    const invalid = runServe(
      { port: 99_999, detached: true },
      {
        readState: () => {
          readCalled = true;
          return Promise.resolve(null);
        },
        controller: new FakeProcessController(),
        spawnDetached: () => Promise.resolve({ pid: 1, port: 1, logFile: '' }),
      }
    );

    await expect(invalid).rejects.toThrow(/out of range/i);
    expect(readCalled).toBe(false);
  });
});
