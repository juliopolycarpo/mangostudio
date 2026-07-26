/**
 * Filesystem locations for MangoStudio runtime daemon state.
 *
 * Anchored at ~/.mango in BOTH dev and standalone modes: daemon state is runtime
 * state, not config, so keeping it out of the repo working tree lets `status`/
 * `stop` resolve the same instance regardless of how the server was launched.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getHomeMangoDir } from './config';

/** Directory holding background server log files. // Usage: getLogsDir() */
export function getLogsDir(): string {
  return join(getHomeMangoDir(), 'logs');
}

/** Directory holding bounded runtime/CLI installer logs. */
export function getInstallLogsDir(): string {
  return join(getLogsDir(), 'installs');
}

/** Path to one audited install run's bounded log file. */
export function getInstallLogPath(runId: string): string {
  return join(getInstallLogsDir(), `${runId}.log`);
}

/** Directory holding runtime state such as the pid/state file. // Usage: getRunDir() */
export function getRunDir(): string {
  return join(getHomeMangoDir(), 'run');
}

/** Path to the single-instance server state file. // Usage: getPidFilePath() */
export function getPidFilePath(): string {
  return join(getRunDir(), 'server.json');
}

/** Timestamped log file path for a background server start. // Usage: getServerLogPath(Date.now()) */
export function getServerLogPath(startedAt: number): string {
  return join(getLogsDir(), `server-${formatTimestamp(startedAt)}.log`);
}

/** Managed working directory for Cursor SDK local agents (hooks + cwd). */
export function getCursorAgentDir(): string {
  return join(getHomeMangoDir(), 'cursor-agent');
}

/** Create the logs and run directories if missing. // Usage: await ensureRuntimeDirs() */
export async function ensureRuntimeDirs(): Promise<void> {
  await mkdir(getLogsDir(), { recursive: true });
  await mkdir(getRunDir(), { recursive: true });
}

/** Format an epoch timestamp as YYYYMMDD-HHmmss for log filenames. */
function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}`;
}
