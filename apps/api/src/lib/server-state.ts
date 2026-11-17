/**
 * Single-instance server state file (JSON) read/write with atomic semantics.
 *
 * The running server owns this file: it writes it once the port is bound and
 * removes it on graceful shutdown. CLI commands (status/stop/killserver) read it
 * to locate and manage the live instance. A file whose pid is dead is "stale"
 * and treated as absent by callers.
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises';

import type { BuildInfo } from './build-info';
import { getPidFilePath } from './mango-paths';

export interface ServerState {
  pid: number;
  port: number;
  host: string;
  startedAt: number;
  logFile: string;
  version: string;
  buildInfo?: BuildInfo;
  frontendDir?: string;
  /** The supervisor unit that started this process, when one did. */
  service?: string;
}

/** Read and parse the state file; null when absent or corrupt. // Usage: await readState() */
export async function readState(path: string = getPidFilePath()): Promise<ServerState | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isServerState(parsed) ? parsed : null;
  } catch {
    // Missing or unparseable → caller treats as "no instance".
    return null;
  }
}

/** Guard a parsed value against the ServerState shape (a partial/old file is "no instance"). */
function isServerState(value: unknown): value is ServerState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return (
    // The CLI signals this pid (`stop`, `killserver`, `restart`). A hand-edited or damaged file
    // naming 0, 1 or a negative number would reach kill(0) (this group), kill(-1) (every process
    // the user owns) or init, so such a file is "no instance".
    typeof state.pid === 'number' &&
    Number.isSafeInteger(state.pid) &&
    state.pid > 1 &&
    typeof state.port === 'number' &&
    typeof state.host === 'string'
  );
}

/** Atomically write the state file via a temp file + rename. // Usage: await writeState(state) */
export async function writeState(
  state: ServerState,
  path: string = getPidFilePath()
): Promise<void> {
  const tmp = `${path}.${state.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

/** Remove the state file, ignoring a missing file. // Usage: await removeState() */
export async function removeState(path: string = getPidFilePath()): Promise<void> {
  await rm(path, { force: true });
}

/** What the CLI needs to ask about the pid a state file names. */
export interface StateProcessProbe {
  isAlive(pid: number): boolean;
  /**
   * When the process started, epoch ms; `undefined` when the platform query failed.
   * A probe without it cannot tell a recycled pid from the hub (unit-test fakes).
   */
  startTimeMs?(pid: number): Promise<number | undefined>;
}

/**
 * - `hub`: alive, and it started no later than the state file says the hub did.
 * - `stale`: dead, or alive but started after the hub wrote its state, so it is
 *   an unrelated process that reused the pid.
 * - `unconfirmed`: alive, but its start time could not be read.
 */
export type StateProcess = 'hub' | 'stale' | 'unconfirmed';

/**
 * Slack between the process start and the `startedAt` the hub stamped, for clock
 * granularity (`ps` and `/proc` resolve to a second or less). The comparison is
 * one-sided: the hub starts before it writes the file, and a process that reuses
 * its pid can only start after the hub has died, so a start later than
 * `startedAt` plus this slack is never the hub.
 */
export const START_TIME_TOLERANCE_MS = 5_000;

/**
 * Classify the process a state file names. A file surviving a SIGKILL or a crash
 * still names a pid that the OS may have given to an editor or a shell; liveness
 * alone cannot see that, so the start time decides. It needs no cooperation from
 * the hub, which is the point: a hung hub never answers a health probe, yet
 * `killserver` must still be able to stop it.
 * // Usage: await classifyStateProcess(state, controller) // → 'hub'
 */
export async function classifyStateProcess(
  state: ServerState,
  probe: StateProcessProbe
): Promise<StateProcess> {
  if (!probe.isAlive(state.pid)) return 'stale';
  if (!probe.startTimeMs) return 'hub';
  const startedMs = await probe.startTimeMs(state.pid);
  if (startedMs === undefined) return 'unconfirmed';
  return startedMs > state.startedAt + START_TIME_TOLERANCE_MS ? 'stale' : 'hub';
}

/**
 * True unless the state file is stale. `unconfirmed` counts as live: a caller that only
 * reads or refuses (status, open, serve, backup) keeps today's answer, and a caller that
 * signals must not rely on this: it asks {@link classifyStateProcess} and refuses.
 * // Usage: await isStateLive(state, controller)
 */
export async function isStateLive(state: ServerState, probe: StateProcessProbe): Promise<boolean> {
  return (await classifyStateProcess(state, probe)) !== 'stale';
}

/**
 * The state file only when a hub may be behind it. A file surviving a SIGKILL (or
 * any crash that skips cleanup) still names a pid, but that pid can already belong
 * to an unrelated, recycled process — every caller that asks "is a hub running?"
 * has to pair the read with the identity check, so the pair lives here rather than
 * at each call site.
 * // Usage: await readLiveState(readState, controller)
 */
export async function readLiveState(
  read: () => Promise<ServerState | null>,
  probe: StateProcessProbe
): Promise<ServerState | null> {
  const state = await read();
  if (!state) return null;
  return (await isStateLive(state, probe)) ? state : null;
}
