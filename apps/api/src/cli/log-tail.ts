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
 * Bytes read for each line asked for. `service.log` is append-only and nothing
 * rotates it, so a hub that has supervised itself for months owns a file no
 * caller should pull into memory whole just to see the end of it \u2014 and the
 * machine page reads it on every visit.
 *
 * Four kilobytes is generous per line: the JSON logger writes a few hundred
 * bytes and the wire contract caps one line at 8 KiB. A file whose lines run
 * longer than this on average yields fewer lines than were asked for, and says
 * so through `truncated` rather than silently looking complete.
 */
export const LOG_TAIL_BYTES_PER_LINE = 4_096;

/** Byte-range access to a log file, so a tail can be read without the head. */
export interface LogTailSource {
  /** Size in bytes, or null when there is no such file. */
  size: (path: string) => Promise<number | null>;
  /**
   * The bytes in `[offset, end)`, decoded as UTF-8; to the end of the file when
   * `end` is omitted. A log is appended to while it is being read, so the
   * caller passes the size it measured: without an upper bound the read runs
   * past it and the offset it reports back is behind what it already returned,
   * which a follower then prints a second time.
   */
  readFrom: (path: string, offset: number, end?: number) => Promise<string>;
}

export interface LogTail {
  readonly lines: string[];
  readonly truncated: boolean;
  /** One byte past what was read \u2014 where `followFile` resumes. */
  readonly offset: number;
}

/**
 * The last `count` lines of a log file, reading a bounded suffix of it. Null
 * when the file is not there.
 * // Usage: await readLogTail('/home/j/.mango/logs/service.log', 200)
 */
export async function readLogTail(
  path: string,
  count: number,
  source: LogTailSource = realLogTailSource()
): Promise<LogTail | null> {
  const size = await source.size(path);
  if (size === null) return null;

  const start = Math.max(0, size - count * LOG_TAIL_BYTES_PER_LINE);
  const content = await source.readFrom(path, start, size);
  if (start === 0) return { ...tailLines(content, count), offset: size };

  // A byte offset lands mid-line, and that fragment is not a line anyone asked
  // for. Dropping it also drops the replacement character the offset makes of a
  // multi-byte character it split. A suffix with no newline at all is one
  // enormous line, of which only a fragment was read: there is nothing to keep.
  const newline = content.indexOf('\n');
  const whole = newline === -1 ? '' : content.slice(newline + 1);
  return { ...tailLines(whole, count), truncated: true, offset: size };
}

export function realLogTailSource(): LogTailSource {
  return {
    size: async (path) => {
      try {
        return (await stat(path)).size;
      } catch {
        return null;
      }
    },
    readFrom: (path, offset, end) => Bun.file(path).slice(offset, end).text(),
  };
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

/**
 * Which log file to read: the one the running instance recorded, else the
 * newest under the logs directory, so the last crash is still readable after
 * the state file is gone. Null when neither names one — a foreground `serve`
 * writes to its terminal and has no file at all.
 * // Usage: await resolveHubLogFile(readState, () => latestHubLogFile(getLogsDir()))
 */
export async function resolveHubLogFile(
  readState: () => Promise<{ readonly logFile?: string } | null>,
  latestLogFile: () => Promise<string | null>
): Promise<string | null> {
  const state = await readState();
  // Falsy, not nullish: a foreground start records an empty `logFile`.
  return state?.logFile || (await latestLogFile());
}

export interface FollowDeps {
  size: (path: string) => Promise<number>;
  readFrom: (path: string, offset: number, end?: number) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  /** Resolves when the follower should stop, e.g. on SIGINT. */
  stopped: Promise<void>;
}

/** Whether an error is the file being gone, rather than unreadable. */
function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Print bytes appended to `path` from `offset` on, until `stopped` resolves.
 * A file that shrinks (rotated or truncated) is read again from the start, and
 * one that disappears between two passes is waited for rather than fatal:
 * `logs -f` is a watch, and `stat` on a renamed file throws. Anything else —
 * a permission the follower has lost, an I/O error — still ends the follow,
 * because a watch that cannot read and cannot say so is a silent spin.
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
    try {
      const size = await deps.size(path);
      if (size < position) position = 0;
      if (size > position) {
        // Bounded by the size just measured, so `position` names exactly what
        // was written and the next pass does not repeat whatever landed
        // meanwhile.
        write(await deps.readFrom(path, position, size));
        position = size;
      }
    } catch (error) {
      // Gone for now — a rotation, or a `service.log` the supervisor recreated.
      // Keep the position and look again; a file that comes back smaller is
      // caught by the shrink check above.
      if (!isMissingFile(error)) throw error;
    }
    await deps.sleep(FOLLOW_INTERVAL_MS);
  }
}

export function realFollowDeps(): FollowDeps {
  return {
    size: async (path) => (await stat(path)).size,
    readFrom: realLogTailSource().readFrom,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stopped: new Promise((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    }),
  };
}
