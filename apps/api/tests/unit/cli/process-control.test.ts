import { describe, expect, it } from 'bun:test';

import { CliError } from '../../../src/cli/errors';
import { SHUTDOWN_REQUEST_TIMEOUT_MS } from '../../../src/cli/hub-shutdown-request';
import {
  createProcessController,
  HARD_STOP_TIMEOUT_MS,
  HUB_SHUTDOWN_WAIT_MS,
  HUB_STOP_DEADLINE_MS,
  stopPidOrThrow,
  terminateHub,
  waitForExit,
} from '../../../src/cli/process-control';
import { RESTART_WAIT_TIMEOUT_MS } from '../../../src/cli/restart-handshake';
import type { ServerState } from '../../../src/lib/server-state';
import { SHUTDOWN_BUDGET_MS } from '../../../src/server/shutdown-request';
import { FakeHubShutdown } from '../../support/mocks/fake-hub-shutdown';
import { FakeProcessController } from '../../support/mocks/fake-process-controller';
import { FakeServerStateFile } from '../../support/mocks/fake-server-state-file';

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
          // Dies only after the hard stop, which comes after the whole graceful wait.
          if (elapsed > HUB_SHUTDOWN_WAIT_MS && controller.terminated.length > 0) {
            controller.die(42);
          }
        }),
      },
      STATE
    );

    expect(stopped).toBe(true);
    expect(controller.terminated).toEqual([42]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(
      `did not exit within ${HUB_SHUTDOWN_WAIT_MS / 1000}s of the shutdown request`
    );
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

describe('win32 stop budgets', () => {
  const STATE: ServerState = {
    pid: 42,
    port: 3001,
    host: '127.0.0.1',
    startedAt: 0,
    logFile: '',
    version: 't',
    controlToken: 'control-token-for-budgets',
  };

  it('keeps the CLI wait after an accepted request strictly longer than the hub stop budget', () => {
    expect(
      HUB_SHUTDOWN_WAIT_MS,
      `expected the CLI wait (${HUB_SHUTDOWN_WAIT_MS}ms) to exceed the hub's stop budget (${SHUTDOWN_BUDGET_MS}ms), so the CLI never ends a hub still inside its budget`
    ).toBeGreaterThan(SHUTDOWN_BUDGET_MS);
  });

  it('keeps request, wait and hard stop together under the hand-over a successor waits for', () => {
    expect(
      HUB_STOP_DEADLINE_MS,
      `expected the stop deadline (${HUB_STOP_DEADLINE_MS}ms) under RESTART_WAIT_TIMEOUT_MS (${RESTART_WAIT_TIMEOUT_MS}ms)`
    ).toBeLessThan(RESTART_WAIT_TIMEOUT_MS);
    expect(HUB_STOP_DEADLINE_MS).toBe(
      SHUTDOWN_REQUEST_TIMEOUT_MS + HUB_SHUTDOWN_WAIT_MS + HARD_STOP_TIMEOUT_MS
    );
  });

  it('ends a hub that accepted the request and never exits inside one deadline, worst-case request included', async () => {
    const controller = new FakeProcessController([42]);
    let now = 0;
    const timeouts: (number | undefined)[] = [];

    await terminateHub(
      {
        controller,
        platform: 'win32',
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
        // A request that takes its whole timeout, then is accepted.
        requestShutdown: (_state, options) => {
          timeouts.push(options?.timeoutMs);
          now += options?.timeoutMs ?? 0;
          return Promise.resolve({ accepted: true });
        },
      },
      STATE
    );

    expect(timeouts).toEqual([SHUTDOWN_REQUEST_TIMEOUT_MS]);
    expect(controller.terminated).toEqual([42]);
    // Polling overshoots a wait by up to one interval each.
    expect(
      now,
      `expected the whole stop to end by ${HUB_STOP_DEADLINE_MS}ms (+ polling) | received: ${now}ms`
    ).toBeLessThanOrEqual(HUB_STOP_DEADLINE_MS + 400);
    expect(now).toBeLessThan(RESTART_WAIT_TIMEOUT_MS);
  });

  it('waits at least the hub budget for an accepted request before ending the hub', async () => {
    const controller = new FakeProcessController([42]);
    let now = 0;
    let terminatedAt: number | undefined;
    const realTerminate = controller.terminate.bind(controller);
    controller.terminate = (pid) => {
      terminatedAt = now;
      realTerminate(pid);
    };

    await terminateHub(
      {
        controller,
        platform: 'win32',
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
        requestShutdown: () => Promise.resolve({ accepted: true }),
      },
      STATE
    );

    expect(
      terminatedAt,
      `expected terminate after the hub's ${SHUTDOWN_BUDGET_MS}ms budget | received: ${terminatedAt}ms`
    ).toBeGreaterThan(SHUTDOWN_BUDGET_MS);
  });
});

describe('state file after a win32 stop through stopPidOrThrow', () => {
  const STATE: ServerState = {
    pid: 42,
    port: 3001,
    host: '127.0.0.1',
    startedAt: 0,
    logFile: '/x.log',
    version: 't',
    controlToken: 'control-token-for-state-cleanup',
  };

  const stopWithFiles = async (options: {
    platform: NodeJS.Platform;
    refuse: boolean;
    successorPid?: number;
  }) => {
    const controller = new FakeProcessController([42]);
    const stateFile = new FakeServerStateFile(STATE);
    const hub = new FakeHubShutdown(
      options.refuse ? { accepted: false, reason: 'refused' } : { accepted: true }
    );
    let now = 0;
    await stopPidOrThrow(
      {
        controller,
        platform: options.platform,
        requestShutdown: hub.request,
        readState: stateFile.readState,
        removeState: stateFile.removeState,
        now: () => now,
        sleep: (ms) => {
          now += ms;
          // A graceful hub exits on its own; a refused one only to the hard stop.
          if (!options.refuse || controller.terminated.length > 0) controller.die(42);
          if (options.successorPid) stateFile.write({ ...STATE, pid: options.successorPid });
          return Promise.resolve();
        },
      },
      STATE,
      'PID 42 did not stop.'
    );
    return stateFile;
  };

  it('is cleared after a hard-kill fallback, which the hub never got to clean up', async () => {
    const stateFile = await stopWithFiles({ platform: 'win32', refuse: true });

    expect(stateFile.present, 'expected the state file removed after the hard stop on win32').toBe(
      false
    );
  });

  it('is left alone when a successor already wrote its own over it', async () => {
    const stateFile = await stopWithFiles({ platform: 'win32', refuse: true, successorPid: 77 });

    expect(stateFile.pid).toBe(77);
  });

  it('is left to the hub on linux, whose SIGTERM handler removes it', async () => {
    const stateFile = await stopWithFiles({ platform: 'linux', refuse: false });

    expect(stateFile.present).toBe(true);
  });
});
