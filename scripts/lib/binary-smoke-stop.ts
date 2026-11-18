// Graceful-stop assertions for the compiled hub, shared by `scripts/test-build.ts`.
//
// `mangostudio stop` ends a Windows hub with `TerminateProcess` unless the hub accepts a
// loopback shutdown request first (apps/api/src/cli/process-control.ts, `terminateHub`). A
// fallback still exits 0 and the pid still goes away, so only the printed notice, the hub's own
// exit code and the state file tell the two paths apart.
//
// Imports nothing but `node:`/`bun` builtins: everything reachable from the smoke must run under
// `--no-install` (see `scripts/tests/smoke-dependencies.unit.test.ts`).

import { connect } from 'node:net';

/**
 * Text that appears in every notice `terminateHub` prints before it ends a hub hard: one when the
 * hub could not be asked or declined, one when it accepted and did not exit in time. They are
 * fragments, not whole lines, because the lines carry a pid and a reason. The contract test in
 * `scripts/tests/binary-smoke-stop.unit.test.ts` drives the real `terminateHub` and fails if a
 * notice stops containing one of them.
 */
const HARD_STOP_NOTICE_FRAGMENTS = [
  'to shut down gracefully:',
  'of the shutdown request; ending it.',
] as const;

/**
 * The first line of `output` that announces a hard-kill fallback, or `undefined` for a graceful stop.
 * @example findHardStopNotice('MangoStudio stopped (PID 4242).') // undefined
 */
export function findHardStopNotice(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .find((line) => HARD_STOP_NOTICE_FRAGMENTS.some((fragment) => line.includes(fragment)));
}

/** What a bounded command left behind. `exitCode` is null when it was killed at the deadline. */
export interface BoundedCommandResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Stdout then stderr. */
  readonly output: string;
}

/**
 * Run a command to completion within `budgetMs`, killing only that child when the budget ends.
 * @example await runBoundedCommand([binary, 'stop'], { cwd: home, env, budgetMs: 30_000 });
 */
export async function runBoundedCommand(
  cmd: string[],
  options: { cwd: string; env: Record<string, string>; budgetMs: number }
): Promise<BoundedCommandResult> {
  const child = Bun.spawn({
    cmd,
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.budgetMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode: timedOut ? null : exitCode, timedOut, output: `${stdout}${stderr}` };
  } finally {
    clearTimeout(timer);
  }
}

/** `refused` is the only state that proves nothing listens. */
export type PortState = 'open' | 'refused' | 'timeout';

/**
 * Dial a loopback port once.
 * @example await probeLoopbackPort(13001, 2_000) // 'refused' once the hub is gone
 */
export function probeLoopbackPort(port: number, timeoutMs: number): Promise<PortState> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const settle = (state: PortState) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => settle('timeout'));
    socket.once('connect', () => settle('open'));
    socket.once('error', () => settle('refused'));
  });
}

/** Everything the graceful-stop check observes, so a test can script it without a hub. */
export interface GracefulStopProbe {
  /** Run the compiled `mangostudio stop` against the hub under test. */
  runStop(): Promise<BoundedCommandResult>;
  /** The hub's own exit code, or `undefined` when it is still running after `budgetMs`. */
  awaitHubExit(budgetMs: number): Promise<number | undefined>;
  stateFileExists(): boolean;
  probePort(): Promise<PortState>;
}

export interface GracefulStopOptions {
  /** How long the hub gets to exit once `stop` has returned. */
  readonly hubExitBudgetMs: number;
  /** The budget `runStop` was given, named in the timeout problem. */
  readonly stopBudgetMs: number;
  readonly port: number;
}

/**
 * Stop the hub the way a user would and list every way the stop was not graceful. The checks all
 * run even after one fails, so a single CI log shows the whole picture; an empty list is a pass.
 * @example const problems = await checkGracefulStop(probe, { hubExitBudgetMs: 10_000, stopBudgetMs: 30_000, port });
 */
export async function checkGracefulStop(
  probe: GracefulStopProbe,
  options: GracefulStopOptions
): Promise<string[]> {
  const problems: string[] = [];
  const stop = await probe.runStop();
  if (stop.timedOut) {
    problems.push(
      `(stop command): expected exit within ${options.stopBudgetMs}ms | received: killed at the deadline`
    );
  } else if (stop.exitCode !== 0) {
    problems.push(`(stop command): expected exit code 0 | received: ${stop.exitCode}`);
  }
  const notice = findHardStopNotice(stop.output);
  if (notice) {
    problems.push(
      `(stop command): expected the graceful path | received hard-kill notice: ${notice}`
    );
  }

  const hubExit = await probe.awaitHubExit(options.hubExitBudgetMs);
  if (hubExit === undefined) {
    problems.push(
      `(hub process): expected exit code 0 within ${options.hubExitBudgetMs}ms of stop | received: still running`
    );
  } else if (hubExit !== 0) {
    problems.push(`(hub process): expected exit code 0 | received: ${hubExit}`);
  }

  if (probe.stateFileExists()) {
    problems.push(
      '(server.json): expected the hub to remove its state file | received: file exists'
    );
  }
  const port = await probe.probePort();
  if (port !== 'refused') {
    problems.push(
      `(port ${options.port}): expected connection refused | received: ${port === 'open' ? 'connection accepted' : 'connect timed out'}`
    );
  }
  if (problems.length > 0 && stop.output.trim()) {
    problems.push(`(stop command) output: ${stop.output.trim()}`);
  }
  return problems;
}
