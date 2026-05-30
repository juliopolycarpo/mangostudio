import { describe, expect, it } from 'bun:test';
import { runStop } from '../../../../src/cli/commands/stop';
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

describe('runStop', () => {
  it('reports nothing to stop when not running', async () => {
    const lines: string[] = [];

    await runStop({
      readState: () => Promise.resolve(null),
      removeState: noop,
      controller: new FakeProcessController(),
      log: (msg) => lines.push(msg),
      now: () => 0,
      sleep: noop,
    });

    expect(lines).toEqual(['No running instance to stop.']);
  });

  it('terminates a running instance and confirms it stopped', async () => {
    const controller = new FakeProcessController([42]);
    const lines: string[] = [];
    let now = 0;
    const sleep = (ms: number): Promise<void> => {
      now += ms;
      controller.die(42); // process exits after the first poll interval
      return Promise.resolve();
    };

    await runStop({
      readState: () => Promise.resolve(STATE),
      removeState: noop,
      controller,
      log: (msg) => lines.push(msg),
      now: () => now,
      sleep,
    });

    expect(controller.terminated).toContain(42);
    expect(lines.join('\n')).toContain('MangoStudio stopped (PID 42).');
  });

  it('reports failure and exits 1 when the process does not stop', async () => {
    const controller = new FakeProcessController([42]);
    const errors: string[] = [];
    let exitCode = -1;
    let now = 0;

    await runStop({
      readState: () => Promise.resolve(STATE),
      removeState: noop,
      controller,
      log: () => undefined,
      error: (msg) => errors.push(msg),
      exit: (code) => {
        exitCode = code;
      },
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('killserver');
  });
});
