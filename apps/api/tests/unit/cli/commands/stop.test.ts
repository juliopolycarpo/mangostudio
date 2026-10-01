import { describe, expect, it } from 'bun:test';
import { runStop } from '../../../../src/cli/commands/stop';
import type { ServerState } from '../../../../src/lib/server-state';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';
import { FakeServerStateFile } from '../../../support/mocks/fake-server-state-file';

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

  describe('server state file after the pid exits', () => {
    const stateAfterStop = async (
      platform: NodeJS.Platform,
      { exits }: { exits: boolean }
    ): Promise<'present' | 'removed'> => {
      const controller = new FakeProcessController([42]);
      const stateFile = new FakeServerStateFile(STATE);
      let now = 0;
      await runStop({
        platform,
        readState: stateFile.readState,
        removeState: stateFile.removeState,
        controller,
        log: () => undefined,
        error: () => undefined,
        exit: () => undefined,
        now: () => now,
        sleep: (ms) => {
          now += ms;
          if (exits) controller.die(42);
          return Promise.resolve();
        },
      });
      return stateFile.present ? 'present' : 'removed';
    };

    it('removes it on win32, where terminate is a hard kill that skips the hub cleanup', async () => {
      const received = await stateAfterStop('win32', { exits: true });

      expect(
        received,
        `expected server state file after stop on win32: removed | received: ${received}`
      ).toBe('removed');
    });

    it('leaves it to the hub on linux, whose SIGTERM handler removes it itself', async () => {
      const received = await stateAfterStop('linux', { exits: true });

      expect(
        received,
        `expected server state file after stop on linux: present | received: ${received}`
      ).toBe('present');
    });

    it('keeps it on win32 while the pid is still alive, so the hub stays findable', async () => {
      const received = await stateAfterStop('win32', { exits: false });

      expect(
        received,
        `expected server state file after a stop that left the pid alive on win32: present | received: ${received}`
      ).toBe('present');
    });
  });
});
