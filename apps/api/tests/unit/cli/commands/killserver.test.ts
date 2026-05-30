import { describe, expect, it } from 'bun:test';
import { runKillServer } from '../../../../src/cli/commands/killserver';
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

describe('runKillServer', () => {
  it('reports nothing to kill when not running', async () => {
    const lines: string[] = [];

    await runKillServer({
      readState: () => Promise.resolve(null),
      removeState: noop,
      controller: new FakeProcessController(),
      log: (msg) => lines.push(msg),
      now: () => 0,
      sleep: noop,
    });

    expect(lines).toEqual(['No running instance to kill.']);
  });

  it('force-kills a running instance and removes its state file', async () => {
    const controller = new FakeProcessController([42]);
    const lines: string[] = [];
    let removed = false;
    let now = 0;
    const sleep = (ms: number): Promise<void> => {
      now += ms;
      controller.die(42);
      return Promise.resolve();
    };

    await runKillServer({
      readState: () => Promise.resolve(STATE),
      removeState: () => {
        removed = true;
        return Promise.resolve();
      },
      controller,
      log: (msg) => lines.push(msg),
      now: () => now,
      sleep,
    });

    expect(controller.killed).toContain(42);
    expect(removed).toBe(true);
    expect(lines.join('\n')).toContain('force-killed (PID 42)');
  });
});
