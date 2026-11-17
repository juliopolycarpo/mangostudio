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
  /**
   * The hub's own process start token (see `process-start-token.ts`), so the CLI can tell the
   * hub from a process that reused its pid. Absent in a file an older hub wrote, and on Windows
   * until the query that fills it returns.
   */
  startToken?: string;
}

/** Read and parse the state file; null when absent or corrupt. // Usage: await readState() */
export async function readState(path: string = getPidFilePath()): Promise<ServerState | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isServerState(parsed) ? withoutMalformedToken(parsed) : null;
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

/**
 * A token that is not a string cannot be compared; drop it so the file reads as "no token"
 * (identity falls back to the clock rule) rather than as a mismatch that would delete the file.
 */
function withoutMalformedToken(state: ServerState): ServerState {
  if (state.startToken === undefined || typeof state.startToken === 'string') return state;
  const { startToken: _malformed, ...rest } = state;
  return rest;
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

/** True when the recorded pid is currently alive. // Usage: isStateLive(state, isAlive) */
export function isStateLive(state: ServerState, isAlive: (pid: number) => boolean): boolean {
  return isAlive(state.pid);
}

/**
 * The state file only when a hub is actually behind it. A file surviving a
 * SIGKILL (or any crash that skips cleanup) still names a pid, but that pid
 * can already belong to an unrelated, recycled process — every caller that
 * asks "is a hub running?" has to pair the read with the liveness check, so
 * the pair lives here rather than at each call site.
 * // Usage: await readLiveState(readState, controller.isAlive)
 */
export async function readLiveState(
  read: () => Promise<ServerState | null>,
  isAlive: (pid: number) => boolean
): Promise<ServerState | null> {
  const state = await read();
  if (!state) return null;
  return isStateLive(state, isAlive) ? state : null;
}

/** What the CLI needs to ask about the pid a state file names, beyond liveness. */
export interface StateProcessProbe {
  isAlive(pid: number): boolean;
  /** The process's start token (equality only); `undefined` when it could not be read. */
  startToken?(pid: number): Promise<string | undefined>;
  /** When the process started, epoch ms; `undefined` when it could not be read. */
  startTimeMs?(pid: number): Promise<number | undefined>;
}

/**
 * - `hub`: the pid is the hub.
 * - `stale`: dead, or alive with a start token that differs from the hub's: another process
 *   reused the pid. The only two verdicts that justify removing the state file.
 * - `unconfirmed`: alive, identity not provable (token unreadable or absent, and the clock rule
 *   does not match). Never grounds for deleting the file or for sending a signal.
 */
export type StateProcess = 'hub' | 'stale' | 'unconfirmed';

/**
 * Slack for the fallback clock rule: `ps` and `/proc` resolve to a second or less, and a hub
 * stamps `startedAt` after it starts.
 */
export const START_TIME_TOLERANCE_MS = 5_000;

/**
 * Who owns the pid a state file names. For the commands that signal it; read-only callers keep
 * plain liveness (`isStateLive`), since this can cost a process spawn.
 *
 * 1. Dead: stale.
 * 2. This very process: the hub, no query.
 * 3. Both the file and the OS give a start token: equal is the hub, different is stale. A token
 *    is the kernel's own record, so no wall-clock step can fake a match or a mismatch.
 * 4. Otherwise (older hub without a token, Windows before its query returned, an unreadable
 *    token) the start time must not be later than `startedAt` plus the tolerance. A mismatch
 *    there is only `unconfirmed`: a wall clock stepped forward after the hub started looks the
 *    same as a recycled pid.
 * // Usage: await classifyStateProcess(state, controller) // → 'hub'
 */
export async function classifyStateProcess(
  state: ServerState,
  probe: StateProcessProbe
): Promise<StateProcess> {
  if (!probe.isAlive(state.pid)) return 'stale';
  if (state.pid === process.pid) return 'hub';
  const current = state.startToken === undefined ? undefined : await probe.startToken?.(state.pid);
  if (state.startToken !== undefined && current !== undefined) {
    return current === state.startToken ? 'hub' : 'stale';
  }
  if (!probe.startTimeMs) return probe.startToken ? 'unconfirmed' : 'hub';
  const startedMs = await probe.startTimeMs(state.pid);
  if (startedMs === undefined) return 'unconfirmed';
  return startedMs > state.startedAt + START_TIME_TOLERANCE_MS ? 'unconfirmed' : 'hub';
}

/**
 * Add this process's start token to the state file it already wrote, for a platform where the
 * query is too slow for the startup path. Does nothing when the token cannot be read, or when the
 * file no longer names this process (the hub already shut down, or a successor wrote its own).
 * // Usage: await attachStartToken({ readState, writeState, readToken })
 */
export async function attachStartToken(deps: {
  readonly readState: () => Promise<ServerState | null>;
  readonly writeState: (state: ServerState) => Promise<void>;
  readonly readToken: () => Promise<string | undefined>;
}): Promise<void> {
  const token = await deps.readToken();
  if (token === undefined) return;
  const current = await deps.readState();
  if (current?.pid !== process.pid) return;
  await deps.writeState({ ...current, startToken: token });
}
