/**
 * Explains a relayed install that produced no output, for the failure message of a wait that timed out
 * (#1311). A stall of tens of seconds against a 286 ms median leaves the log with an empty line list and
 * nothing else, so this reads what the Hub can still observe once the wait gave up:
 *
 * - whether the runtime process exists and answers `runtime.health` (a blocked runtime does not);
 * - whether the runtime reserved the run id. There is no install status RPC, so a harmless second
 *   `install.run` under the same id is the probe: `already active` means the runtime accepted the original
 *   request, a result means it never did, and no answer means the runtime could not take the call;
 * - the installer's process and its CPU time (a child that exists with no CPU time is blocked, not busy);
 * - the runtime's stderr tail and the time since the run started.
 *
 * Every step is bounded and swallows its own failure, so the diagnosis never replaces the timeout it explains.
 */

import { dirname, join } from 'node:path';

import type { RuntimeClient } from '../../src/services/runtime-client/runtime-client';
import { isProcessAbsent } from './process-liveness';

const PROBE_TIMEOUT_MS = 2_000;
const PROCESS_LIST_TIMEOUT_MS = 5_000;
const STDERR_TAIL_CHARS = 2_048;
const PROCESS_LIST_CHARS = 1_500;

/** The two client calls the probe makes; the real `RuntimeClient` satisfies it. */
type StallProbeRuntime = Pick<RuntimeClient, 'health' | 'install'>;

export interface InstallStallProbeOptions {
  readonly runtime: StallProbeRuntime;
  readonly runtimePid: () => number | undefined;
  readonly runtimeStderr: () => string;
  readonly runId: string;
  /** `Date.now()` when the install request was issued. */
  readonly startedAt: number;
  /** Where the harmless duplicate run writes its log; a scratch path beside the real one. */
  readonly probeLogPath: string;
  readonly now?: () => number;
  /** The installer processes visible to the host, as one line of text. */
  readonly listProcesses?: (runtimePid: number | undefined) => Promise<string>;
}

/** The scratch log path the duplicate run uses, beside the run's own log. */
export function stallProbeLogPath(runLogPath: string): string {
  return join(dirname(runLogPath), 'stall-probe.log');
}

/** A command that exits 0 at once, so the duplicate run cannot change anything if it does start. */
function harmlessArgv(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['cmd.exe', '/d', '/c', 'exit 0'] : ['sh', '-c', 'true'];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves with `work`'s value, or `timeout` text if it takes longer than `ms`. */
async function bounded<T>(work: Promise<T>, ms: number, timeout: string): Promise<T | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(timeout), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeHealth(runtime: StallProbeRuntime, now: () => number): Promise<string> {
  const began = now();
  try {
    await runtime.health({ timeoutMs: PROBE_TIMEOUT_MS });
    return `runtime.health answered in ${now() - began}ms`;
  } catch (error) {
    return `runtime.health did not answer within ${PROBE_TIMEOUT_MS}ms (${reason(error)})`;
  }
}

async function probeRunReservation(
  options: InstallStallProbeOptions,
  platform: NodeJS.Platform
): Promise<string> {
  try {
    await options.runtime.install.run(
      {
        runId: options.runId,
        argv: harmlessArgv(platform),
        timeoutMs: 5_000,
        logPath: options.probeLogPath,
      },
      { timeoutMs: PROBE_TIMEOUT_MS }
    );
    return 'the runtime had not reserved the run id (the probe itself ran, so the request never reached the handler)';
  } catch (error) {
    const message = reason(error);
    return /already active/.test(message)
      ? 'the runtime holds the run id (the request reached the handler)'
      : `the duplicate run got no usable answer within ${PROBE_TIMEOUT_MS}ms (${message})`;
  }
}

async function listHostProcesses(runtimePid: number | undefined): Promise<string> {
  const argv =
    process.platform === 'win32'
      ? ['tasklist', '/v', '/fo', 'csv', '/fi', 'IMAGENAME eq powershell.exe']
      : ['ps', '-o', 'pid=,ppid=,etime=,time=,stat=,args=', '--ppid', String(runtimePid ?? 0)];
  const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const output = await bounded(
    Promise.all([new Response(child.stdout).text(), child.exited]).then(([text]) => text),
    PROCESS_LIST_TIMEOUT_MS,
    `process listing timed out after ${PROCESS_LIST_TIMEOUT_MS}ms`
  );
  if (child.exitCode === null) child.kill();
  return (
    output
      .replace(/\r?\n+/g, ' | ')
      .trim()
      .slice(0, PROCESS_LIST_CHARS) || 'no matching process'
  );
}

/**
 * What a timed-out install wait does before it rethrows: diagnose while the run is still stuck, then
 * release the installer, then append the diagnosis to `error`'s message (the original text is kept).
 * Left waiting, the installer holds the runtime open until its own timeout and the test's cleanup
 * outlives the test timeout, which replaces the message with a bare "timed out". Neither step can throw.
 *
 * @example
 * await explainStalledWait(error, { diagnose, release: () => writeFile(installer.release, 'finish') });
 * throw error;
 */
export async function explainStalledWait(
  error: unknown,
  steps: {
    readonly diagnose?: () => Promise<string>;
    readonly release: () => Promise<unknown>;
  }
): Promise<void> {
  const stall = await steps
    .diagnose?.()
    .catch((cause: unknown) => `probe failed: ${String(cause)}`);
  await steps.release().catch(() => undefined);
  if (stall && error instanceof Error) error.message += `; stall probe: ${stall}`;
}

/**
 * Builds the text a timed-out install wait appends to its message.
 *
 * @example
 * throw new Error(`${base}; stall probe: ${await describeInstallStall(options)}`);
 */
export async function describeInstallStall(
  options: InstallStallProbeOptions,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  const now = options.now ?? Date.now;
  const pid = options.runtimePid();
  let runtimeProcess = 'runtime pid unknown';
  if (pid !== undefined) {
    try {
      runtimeProcess = `runtime pid ${pid} ${isProcessAbsent(pid) ? 'is gone' : 'is alive'}`;
    } catch (error) {
      runtimeProcess = `runtime pid ${pid} liveness unproven (${reason(error)})`;
    }
  }
  // Sequential on purpose: the duplicate run must not race the health call for the runtime's attention.
  const health = await probeHealth(options.runtime, now);
  const reservation = await probeRunReservation(options, platform);
  const processes = await (options.listProcesses ?? listHostProcesses)(pid).catch(
    (error: unknown) => `process listing failed (${reason(error)})`
  );
  const stderr = options.runtimeStderr().slice(-STDERR_TAIL_CHARS);
  return [
    `sinceRunStartMs=${now() - options.startedAt}`,
    runtimeProcess,
    health,
    reservation,
    `installer processes=${JSON.stringify(processes)}`,
    `runtimeStderr=${JSON.stringify(stderr)}`,
  ].join('; ');
}
