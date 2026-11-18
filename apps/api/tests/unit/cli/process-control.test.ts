import { describe, expect, it } from 'bun:test';

import { CliError } from '../../../src/cli/errors';
import {
  createProcessController,
  stopPidOrThrow,
  terminateHub,
  waitForExit,
} from '../../../src/cli/process-control';
import type { ServerState } from '../../../src/lib/server-state';
import { FakeHubShutdown } from '../../support/mocks/fake-hub-shutdown';
import { FakeProcessController } from '../../support/mocks/fake-process-controller';

const NEVER_A_PID = 2_147_483_646;
const noSleep = (): Promise<void> => Promise.resolve();

describe('createProcessController.isAlive', () => {
  it('reports the current process as alive', () => {
    expect(createProcessController().isAlive(process.pid)).toBe(true);
  });

  it('reports an unused pid as dead', () => {
    expect(createProcessController().isAlive(NEVER_A_PID)).toBe(false);
  });
});

describe('waitForExit', () => {
  const waitOpts = (now: () => number, sleep: (ms: number) => Promise<void>) => ({
    timeoutMs: 1000,
    intervalMs: 100,
    now,
    sleep,
  });

  it('returns true immediately when the pid is already dead', async () => {
    const controller = new FakeProcessController();
    const result = await waitForExit(
      controller,
      10,
      waitOpts(() => 0, noSleep)
    );
    expect(result).toBe(true);
  });

  it('returns true once the pid dies before the deadline', async () => {
    const controller = new FakeProcessController([10]);
    let now = 0;
    const sleep = (ms: number): Promise<void> => {
      now += ms;
      if (now >= 250) {
        controller.die(10);
      }
      return Promise.resolve();
    };

    const result = await waitForExit(
      controller,
      10,
      waitOpts(() => now, sleep)
    );
    expect(result).toBe(true);
    expect(now).toBeLessThan(1000);
  });

  it('returns false when the pid never dies before the timeout', async () => {
    const controller = new FakeProcessController([10]);
    let now = 0;
    const sleep = (ms: number): Promise<void> => {
      now += ms;
      return Promise.resolve();
    };

    const result = await waitForExit(controller, 10, {
      timeoutMs: 500,
      intervalMs: 100,
      now: () => now,
      sleep,
    });
    expect(result).toBe(false);
  });
});

describe('terminateHub and stopPidOrThrow', () => {
  const STATE: ServerState = {
    pid: 42,
    port: 3001,
    host: '127.0.0.1',
    startedAt: 0,
    logFile: '',
    version: 't',
    controlToken: 'control-token-for-process-control',
  };

  /** A clock that advances by each sleep and lets the test end the pid at a chosen moment. */
  const clock = (onTick: (elapsedMs: number) => void) => {
    let now = 0;
    return {
      now: () => now,
      sleep: (ms: number): Promise<void> => {
        now += ms;
        onTick(now);
        return Promise.resolve();
      },
    };
  };

  it('on win32 stops a hub through its own request and sends no terminate', async () => {
    const controller = new FakeProcessController([42]);
    const hub = new FakeHubShutdown({ accepted: true });

    const stopped = await terminateHub(
      {
        controller,
        platform: 'win32',
        requestShutdown: hub.request,
        ...clock(() => controller.die(42)),
      },
      STATE
    );

    expect(stopped).toBe(true);
    expect(controller.terminated).toEqual([]);
  });

  it('on win32 terminates after the budget when the hub accepted but never exited, and reports it', async () => {
    const controller = new FakeProcessController([42]);
    const hub = new FakeHubShutdown({ accepted: true });
    const notices: string[] = [];

    const stopped = await terminateHub(
      {
        controller,
        platform: 'win32',
        requestShutdown: hub.request,
        notice: (message) => notices.push(message),
        ...clock((elapsed) => {
          // Dies only after the hard stop, which comes after the 10s graceful budget.
          if (elapsed > 10_000 && controller.terminated.length > 0) controller.die(42);
        }),
      },
      STATE
    );

    expect(stopped).toBe(true);
    expect(controller.terminated).toEqual([42]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('did not exit within 10s of the shutdown request');
  });

  it('on linux sends only the signal', async () => {
    const controller = new FakeProcessController([42]);
    const hub = new FakeHubShutdown({ accepted: true });

    const stopped = await terminateHub(
      {
        controller,
        platform: 'linux',
        requestShutdown: hub.request,
        ...clock(() => controller.die(42)),
      },
      STATE
    );

    expect(stopped).toBe(true);
    expect(hub.requested).toEqual([]);
    expect(controller.terminated).toEqual([42]);
  });

  it('stopPidOrThrow takes the graceful path on win32, as restart, install and upgrade rely on', async () => {
    const controller = new FakeProcessController([42]);
    const hub = new FakeHubShutdown({ accepted: true });

    await stopPidOrThrow(
      {
        controller,
        platform: 'win32',
        requestShutdown: hub.request,
        ...clock(() => controller.die(42)),
      },
      STATE,
      'PID 42 did not stop.'
    );

    expect(hub.requested.map((state) => state.pid)).toEqual([42]);
    expect(controller.terminated).toEqual([]);
  });

  it('stopPidOrThrow raises the caller message when the hub survives the request and the terminate', async () => {
    const controller = new FakeProcessController([42]);
    const hub = new FakeHubShutdown({ accepted: true });

    const failure = stopPidOrThrow(
      { controller, platform: 'win32', requestShutdown: hub.request, ...clock(() => undefined) },
      STATE,
      'PID 42 did not stop.'
    );

    await expect(failure).rejects.toThrow(new CliError('PID 42 did not stop.'));
    expect(controller.terminated).toEqual([42]);
  });

  it('stopPidOrThrow never asks a pid that is not the hub', async () => {
    const controller = new FakeProcessController([42]);
    controller.startTokenOf(42, 'some-other-process');
    const hub = new FakeHubShutdown({ accepted: true });

    const failure = stopPidOrThrow(
      { controller, platform: 'win32', requestShutdown: hub.request, ...clock(() => undefined) },
      { ...STATE, startToken: 'the-hub-token' },
      'PID 42 did not stop.'
    );

    await expect(failure).rejects.toThrow('no signal was sent');
    expect(hub.requested, 'expected no token to be sent to a recycled pid').toEqual([]);
  });
});
