// Pid handling for tests that signal processes by a pid they read from a file, a log line or
// parsed text.
//
// `process.kill(0, ...)` signals the caller's own process group and `process.kill(-1, ...)` every
// process the user owns, so a pid that is empty, `0`, `1`, negative or `NaN` must never reach it.
// Bun also coerces an empty string to `0` rather than throwing. A fake that writes its pid file
// with `writeFileSync` can be read between create and write, which makes `Number('')` a real `0`.
//
// Same rule as the runner guardian's protocol parser (scripts/lib/runner-guardian.ts):
// pids below 2 are never a process a test started.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/** The lowest pid a test may signal: 0 is the caller's group, 1 is init, -1 is everyone. */
const LOWEST_SIGNALABLE_PID = 2;

/** `value` as the message shows it: strings quoted, so an empty file reads as `""`. */
function describeReceived(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * Returns `value` when it is a safe integer above 1; throws otherwise. Strings are refused
 * (including `"4242"`): parse text with {@link parsePidText} first.
 *
 * @example
 * assertSignalablePid(4242); // 4242
 * assertSignalablePid(0); // throws "expected pid > 1 | received: 0"
 */
export function assertSignalablePid(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < LOWEST_SIGNALABLE_PID) {
    throw new Error(`expected pid > 1 | received: ${describeReceived(value)}`);
  }
  return value;
}

/**
 * Parses the text of a pid file or a pid column: decimal digits, surrounding whitespace allowed.
 * An empty or partly written file, `"abc"` or `"-1"` throws with the raw text in the message.
 *
 * @example
 * parsePidText('4242\n'); // 4242
 * parsePidText(''); // throws 'expected pid > 1 | received: ""'
 */
export function parsePidText(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d{1,15}$/.test(trimmed) || Number(trimmed) < LOWEST_SIGNALABLE_PID) {
    throw new Error(`expected pid > 1 | received: ${describeReceived(raw)}`);
  }
  return Number(trimmed);
}

/**
 * Reads and parses one pid file.
 *
 * @example
 * const workerPid = readPidFile(join(dir, 'tree-worker-1.pid'));
 */
export function readPidFile(path: string): number {
  const raw = readFileSync(path, 'utf8');
  try {
    return parsePidText(raw);
  } catch (error) {
    throw new Error(`pid file ${path}: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Writes a pid file so a reader sees either no file or the whole pid, never an empty file: the
 * pid goes to a `.tmp` sibling first, then is renamed over `path`. Readers that list a directory
 * must skip `.tmp` names.
 *
 * @example
 * writePidFileAtomically(join(dir, 'worker-1.pid'), process.pid);
 */
export function writePidFileAtomically(path: string, pid: number): void {
  assertSignalablePid(pid);
  const staging = `${path}.tmp`;
  writeFileSync(staging, String(pid));
  renameSync(staging, path);
}

/**
 * Signals one process after checking its pid. Throws on a pid that is not above 1; errors from
 * the kill itself (ESRCH for a process that is gone) pass through.
 *
 * @example
 * signalPid(workerPid, 'SIGKILL');
 */
export function signalPid(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(assertSignalablePid(pid), signal);
}

/**
 * Signals the process group `pid` leads (POSIX), after checking its pid.
 *
 * @example
 * signalPidGroup(runner.pid, 'SIGKILL');
 */
export function signalPidGroup(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(-assertSignalablePid(pid), signal);
}
