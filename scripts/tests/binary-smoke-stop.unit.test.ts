import { describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';

import {
  type ProcessController,
  terminateHub,
} from '@mangostudio/api/internal/cli/process-control';
import type { ServerState } from '@mangostudio/api/internal/lib/server-state';

import {
  type BoundedCommandResult,
  checkGracefulStop,
  findHardStopNotice,
  type GracefulStopProbe,
  type PortState,
  probeLoopbackPort,
  runBoundedCommand,
} from '../lib/binary-smoke-stop';

/** Scripted observations of one stop; the defaults are a clean graceful stop. */
class FakeStopProbe implements GracefulStopProbe {
  stop: BoundedCommandResult = {
    exitCode: 0,
    timedOut: false,
    output: 'MangoStudio stopped (PID 4242).\n',
  };
  hubExit: number | undefined = 0;
  stateFile = false;
  port: PortState = 'refused';
  hubExitBudgets: number[] = [];

  runStop(): Promise<BoundedCommandResult> {
    return Promise.resolve(this.stop);
  }
  awaitHubExit(budgetMs: number): Promise<number | undefined> {
    this.hubExitBudgets.push(budgetMs);
    return Promise.resolve(this.hubExit);
  }
  stateFileExists(): boolean {
    return this.stateFile;
  }
  probePort(): Promise<PortState> {
    return Promise.resolve(this.port);
  }
}

const OPTIONS = { hubExitBudgetMs: 10_000, stopBudgetMs: 30_000, port: 13001 };

describe('checkGracefulStop', () => {
  test('reports nothing for a graceful stop and hands the hub its exit budget', async () => {
    const probe = new FakeStopProbe();
    expect(await checkGracefulStop(probe, OPTIONS)).toEqual([]);
    expect(probe.hubExitBudgets).toEqual([10_000]);
  });

  test('names a stop command that exited non-zero, with its output', async () => {
    const probe = new FakeStopProbe();
    probe.stop = { exitCode: 1, timedOut: false, output: 'did not stop in time\n' };
    expect(await checkGracefulStop(probe, OPTIONS)).toEqual([
      '(stop command): expected exit code 0 | received: 1',
      '(stop command) output: did not stop in time',
    ]);
  });

  test('names a stop command killed at its deadline', async () => {
    const probe = new FakeStopProbe();
    probe.stop = { exitCode: null, timedOut: true, output: '' };
    expect(await checkGracefulStop(probe, OPTIONS)).toEqual([
      '(stop command): expected exit within 30000ms | received: killed at the deadline',
    ]);
  });

  test('flags a hard-kill fallback even though stop exited 0 and the hub is gone', async () => {
    const probe = new FakeStopProbe();
    probe.stop = {
      exitCode: 0,
      timedOut: false,
      output:
        'Could not ask MangoStudio (PID 4242) to shut down gracefully: the hub answered HTTP 401. Ending it; in-flight work is not finished.\nMangoStudio stopped (PID 4242).\n',
    };
    const problems = await checkGracefulStop(probe, OPTIONS);
    expect(problems[0]).toStartWith(
      '(stop command): expected the graceful path | received hard-kill notice: Could not ask'
    );
    expect(problems).toHaveLength(2);
  });

  test('names a hub that is still running after the budget', async () => {
    const probe = new FakeStopProbe();
    probe.hubExit = undefined;
    expect(await checkGracefulStop(probe, OPTIONS)).toEqual([
      '(hub process): expected exit code 0 within 10000ms of stop | received: still running',
      '(stop command) output: MangoStudio stopped (PID 4242).',
    ]);
  });

  test('names a hub that exited with a non-zero code', async () => {
    const probe = new FakeStopProbe();
    probe.hubExit = 143;
    expect((await checkGracefulStop(probe, OPTIONS))[0]).toBe(
      '(hub process): expected exit code 0 | received: 143'
    );
  });

  test('names a state file left behind', async () => {
    const probe = new FakeStopProbe();
    probe.stateFile = true;
    expect((await checkGracefulStop(probe, OPTIONS))[0]).toBe(
      '(server.json): expected the hub to remove its state file | received: file exists'
    );
  });

  test.each([
    ['open', 'connection accepted'],
    ['timeout', 'connect timed out'],
  ] as const)('names a port that answers %s', async (port, received) => {
    const probe = new FakeStopProbe();
    probe.port = port;
    expect((await checkGracefulStop(probe, OPTIONS))[0]).toBe(
      `(port 13001): expected connection refused | received: ${received}`
    );
  });

  test('keeps checking after the first failure so one log shows every problem', async () => {
    const probe = new FakeStopProbe();
    probe.stop = { exitCode: 1, timedOut: false, output: '' };
    probe.hubExit = undefined;
    probe.stateFile = true;
    probe.port = 'open';
    const problems = await checkGracefulStop(probe, OPTIONS);
    expect(problems.map((problem) => problem.split(':')[0])).toEqual([
      '(stop command)',
      '(hub process)',
      '(server.json)',
      '(port 13001)',
    ]);
  });
});

describe('findHardStopNotice', () => {
  test('is undefined for the graceful success line', () => {
    expect(findHardStopNotice('MangoStudio stopped (PID 4242).\r\n')).toBeUndefined();
  });

  test('returns only the matching line', () => {
    const line =
      'MangoStudio (PID 7) did not exit within 12.5s of the shutdown request; ending it.';
    expect(findHardStopNotice(`${line}\nMangoStudio stopped (PID 7).`)).toBe(line);
  });
});

/** An in-memory process table for `terminateHub`; a hub exits only when the test says so. */
class FakeHubProcesses implements ProcessController {
  private alive = new Set<number>([4242]);
  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }
  startTimeMs(): Promise<number | undefined> {
    return Promise.resolve(undefined);
  }
  startToken(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  terminate(pid: number): void {
    this.alive.delete(pid);
  }
  kill(pid: number): void {
    this.alive.delete(pid);
  }
  exit(pid: number): void {
    this.alive.delete(pid);
  }
}

const HUB_STATE: ServerState = {
  pid: 4242,
  port: 13001,
  host: '127.0.0.1',
  startedAt: 0,
  logFile: 'hub.log',
  version: '0.0.0',
  controlToken: 'token',
};

/** Run the real win32 `terminateHub` and collect what it prints. */
async function noticesFrom(
  answer: { accepted: true } | { accepted: false; reason: string },
  hubExitsOnRequest: boolean
): Promise<string[]> {
  const processes = new FakeHubProcesses();
  const notices: string[] = [];
  let now = 0;
  await terminateHub(
    {
      controller: processes,
      platform: 'win32',
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
      requestShutdown: () => {
        if (hubExitsOnRequest) processes.exit(HUB_STATE.pid);
        return Promise.resolve(answer);
      },
      notice: (message) => notices.push(message),
      readState: () => Promise.resolve(null),
      removeState: () => Promise.resolve(),
    },
    HUB_STATE
  );
  return notices;
}

describe('the notices terminateHub prints', () => {
  // If this fails, `terminateHub` reworded a fallback notice: update HARD_STOP_NOTICE_FRAGMENTS, or
  // the Windows smoke stops noticing a hub that was ended hard.
  test('a refusal is recognised by the smoke', async () => {
    const notices = await noticesFrom(
      { accepted: false, reason: 'the hub answered HTTP 401' },
      false
    );
    expect(notices).toHaveLength(1);
    expect(findHardStopNotice(notices.join('\n'))).toBe(notices[0]);
  });

  test('an accepted request the hub never honours is recognised by the smoke', async () => {
    const notices = await noticesFrom({ accepted: true }, false);
    expect(notices).toHaveLength(1);
    expect(findHardStopNotice(notices.join('\n'))).toBe(notices[0]);
  });

  test('a graceful stop prints nothing the smoke would flag', async () => {
    expect(await noticesFrom({ accepted: true }, true)).toEqual([]);
  });
});

describe('runBoundedCommand', () => {
  const env = { ...process.env } as Record<string, string>;

  test('returns the exit code and both streams', async () => {
    const result = await runBoundedCommand(
      [process.execPath, '-e', 'console.log("out"); console.error("err"); process.exit(3)'],
      { cwd: process.cwd(), env, budgetMs: 15_000 }
    );
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
  });

  test('kills only its own child at the deadline and reports it', async () => {
    const result = await runBoundedCommand(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      { cwd: process.cwd(), env, budgetMs: 300 }
    );
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
  });
});

describe('probeLoopbackPort', () => {
  test('reports open for a listener and refused once it closes', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    expect(await probeLoopbackPort(address.port, 2_000)).toBe('open');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeLoopbackPort(address.port, 2_000)).toBe('refused');
  });
});
