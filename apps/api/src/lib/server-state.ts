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
    typeof state.pid === 'number' &&
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

/** True when the recorded pid is currently alive. // Usage: isStateLive(state, isAlive) */
export function isStateLive(state: ServerState, isAlive: (pid: number) => boolean): boolean {
  return isAlive(state.pid);
}
