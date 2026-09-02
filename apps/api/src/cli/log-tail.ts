/**
 * Reading the hub's log files: the last N lines of one, the newest one in
 * the logs directory, and a follow loop for `logs -f`. Kept apart from the
 * command so the machine API can tail the same file the same way.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FOLLOW_INTERVAL_MS = 500;
/** The wire contract's per-line cap; a longer line is cut, never dropped. */
export const LOG_LINE_MAX_CHARS = 8_192;
const LOG_LINE_CUT_MARK = '…';

function capLine(line: string): string {
  if (line.length <= LOG_LINE_MAX_CHARS) return line;
  return `${line.slice(0, LOG_LINE_MAX_CHARS - LOG_LINE_CUT_MARK.length)}${LOG_LINE_CUT_MARK}`;
}

/** The last `count` lines of `content`, without a trailing empty line. */
export function tailLines(content: string, count: number): { lines: string[]; truncated: boolean } {
  // Windows PowerShell writes a byte-order mark first; it is not a log line.
  const all = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (all.at(-1) === '') all.pop();
  const lines = all.slice(-count).map(capLine);
  return { lines, truncated: all.length > lines.length };
}

/**
 * The most recently modified hub log in `logsDir`, or null. Both the detached
 * `server-*.log` files and the service's `service.log` qualify; installer logs
 * under `installs/` do not.
 */
export async function latestHubLogFile(logsDir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(logsDir);
  } catch {
    return null;
  }
  const candidates = names.filter(
    (name) => name === 'service.log' || (name.startsWith('server-') && name.endsWith('.log'))
  );
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of candidates) {
    const path = join(logsDir, name);
    try {
      const info = await stat(path);
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs };
    } catch {
      // Removed between readdir and stat; not a candidate any more.
    }
  }
  return newest?.path ?? null;
}

export interface FollowDeps {
  size: (path: string) => Promise<number>;
  readFrom: (path: string, offset: number) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  /** Resolves when the follower should stop, e.g. on SIGINT. */
  stopped: Promise<void>;
}

/**
 * Print bytes appended to `path` from `offset` on, until `stopped` resolves.
 * A file that shrinks (rotated or truncated) is read again from the start.
 */
export async function followFile(
  path: string,
  offset: number,
  write: (chunk: string) => void,
  deps: FollowDeps
): Promise<void> {
  let position = offset;
  let running = true;
  void deps.stopped.then(() => {
    running = false;
  });
  while (running) {
    const size = await deps.size(path);
    if (size < position) position = 0;
    if (size > position) {
      write(await deps.readFrom(path, position));
      position = size;
    }
    await deps.sleep(FOLLOW_INTERVAL_MS);
  }
}

export function realFollowDeps(): FollowDeps {
  return {
    size: async (path) => (await stat(path)).size,
    readFrom: (path, offset) => Bun.file(path).slice(offset).text(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stopped: new Promise((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    }),
  };
}
