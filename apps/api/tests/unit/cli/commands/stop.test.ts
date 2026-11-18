import { describe, expect, it } from 'bun:test';

import { runStop } from '../../../../src/cli/commands/stop';
import { HUB_SHUTDOWN_WAIT_MS } from '../../../../src/cli/process-control';
import type { ServerState } from '../../../../src/lib/server-state';
import { FakeHubShutdown } from '../../../support/mocks/fake-hub-shutdown';
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

    it('keeps the file of a successor hub that wrote it while stop waited on win32', async () => {
      const controller = new FakeProcessController([42]);
      const stateFile = new FakeServerStateFile(STATE);
      const successor: ServerState = { ...STATE, pid: 77 };
      let now = 0;
      await runStop({
        platform: 'win32',
        readState: stateFile.readState,
        removeState: stateFile.removeState,
        controller,
        log: () => undefined,
        error: () => undefined,
        exit: () => undefined,
        now: () => now,
        sleep: (ms) => {
          now += ms;
          controller.die(42);
          stateFile.write(successor);
          return Promise.resolve();
        },
      });

      expect(
        stateFile.pid,
        `expected server state file pid after stop on win32 with a successor: 77 | received: ${stateFile.pid}`
      ).toBe(77);
    });
  });

  describe('graceful shutdown request', () => {
    const TOKEN_STATE: ServerState = { ...STATE, controlToken: 'control-token-for-stop-tests' };

    /** Runs `stop` against a pid that exits when `exitsWhen` says so; collects what it printed. */
    const stopWith = async (options: {
      platform: NodeJS.Platform;
      state?: ServerState | null;
      hub: FakeHubShutdown;
      /** Called on each poll with the elapsed ms; true makes the pid exit. */
      exitsWhen: (elapsedMs: number, controller: FakeProcessController) => boolean;
    }) => {
      const controller = new FakeProcessController([42]);
      const stateFile = new FakeServerStateFile(
        options.state === undefined ? TOKEN_STATE : options.state
      );
      const lines: string[] = [];
      const errors: string[] = [];
      let exitCode: number | undefined;
      let now = 0;
      await runStop({
        platform: options.platform,
        readState: stateFile.readState,
        removeState: stateFile.removeState,
        controller,
        requestShutdown: options.hub.request,
        log: (msg) => lines.push(msg),
        error: (msg) => errors.push(msg),
        exit: (code) => {
          exitCode = code;
        },
        now: () => now,
        sleep: (ms) => {
          now += ms;
          if (options.exitsWhen(now, controller)) controller.die(42);
          return Promise.resolve();
        },
      });
      return { controller, stateFile, lines, errors, exitCode };
    };

    it('on win32 asks the hub to stop and never terminates a hub that exits on its own', async () => {
      const hub = new FakeHubShutdown({ accepted: true });

      const { controller, lines, errors, exitCode } = await stopWith({
        platform: 'win32',
        hub,
        exitsWhen: () => true,
      });

      expect(
        { requests: hub.requested.map((s) => s.pid), terminated: controller.terminated },
        'expected one shutdown request to pid 42 and no terminate call after a graceful exit'
      ).toEqual({ requests: [42], terminated: [] });
      expect(lines).toEqual(['MangoStudio stopped (PID 42).']);
      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();
    });

    it('on win32 falls back to terminate, and says so, when the hub outlives the request', async () => {
      const hub = new FakeHubShutdown({ accepted: true });

      const { controller, lines, exitCode } = await stopWith({
        platform: 'win32',
        hub,
        // The request is ignored; only the hard stop ends the pid.
        exitsWhen: (_elapsed, c) => c.terminated.length > 0,
      });

      expect(controller.terminated, 'expected the fallback to terminate pid 42 once').toEqual([42]);
      expect(lines.join('\n')).toContain(
        `did not exit within ${HUB_SHUTDOWN_WAIT_MS / 1000}s of the shutdown request`
      );
      expect(lines.at(-1)).toBe('MangoStudio stopped (PID 42).');
      expect(exitCode).toBeUndefined();
    });

    it('on win32 terminates at once, and says why, when the hub refuses the request', async () => {
      const hub = new FakeHubShutdown({ accepted: false, reason: 'the hub answered HTTP 401' });

      const { controller, lines } = await stopWith({
        platform: 'win32',
        hub,
        exitsWhen: (_elapsed, c) => c.terminated.length > 0,
      });

      expect(controller.terminated).toEqual([42]);
      expect(lines.join('\n')).toContain('the hub answered HTTP 401');
    });

    it('on win32 fails with exit 1 when neither the request nor the terminate ends the pid', async () => {
      const hub = new FakeHubShutdown({ accepted: true });

      const { controller, errors, exitCode } = await stopWith({
        platform: 'win32',
        hub,
        exitsWhen: () => false,
      });

      expect(controller.terminated).toEqual([42]);
      expect(exitCode).toBe(1);
      expect(errors.join('\n')).toContain('killserver');
    });

    it('does not ask a hub that is not running', async () => {
      const hub = new FakeHubShutdown({ accepted: true });

      const { controller, lines } = await stopWith({
        platform: 'win32',
        state: null,
        hub,
        exitsWhen: () => true,
      });

      expect(hub.requested).toEqual([]);
      expect(controller.terminated).toEqual([]);
      expect(lines).toEqual(['No running instance to stop.']);
    });

    it('does not ask a hub whose pid is dead, and drops its state file', async () => {
      const hub = new FakeHubShutdown({ accepted: true });
      const stateFile = new FakeServerStateFile(TOKEN_STATE);
      const lines: string[] = [];

      await runStop({
        platform: 'win32',
        readState: stateFile.readState,
        removeState: stateFile.removeState,
        controller: new FakeProcessController([]),
        requestShutdown: hub.request,
        log: (msg) => lines.push(msg),
        now: () => 0,
        sleep: noop,
      });

      expect(hub.requested).toEqual([]);
      expect(stateFile.present).toBe(false);
      expect(lines).toEqual(['No running instance to stop.']);
    });

    it('on linux sends SIGTERM and never makes the request', async () => {
      const hub = new FakeHubShutdown({ accepted: true });

      const { controller } = await stopWith({
        platform: 'linux',
        hub,
        exitsWhen: () => true,
      });

      expect(hub.requested, 'expected no shutdown request on linux').toEqual([]);
      expect(controller.terminated).toEqual([42]);
    });
  });
});
