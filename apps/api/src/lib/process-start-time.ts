/**
 * When a process started, read from the operating system without a native
 * dependency. The hub's CLI uses it to tell the hub apart from an unrelated
 * process that reused the hub's pid after the hub died (see `server-state.ts`).
 *
 * Linux reads `/proc`, macOS asks `ps` for the elapsed time (locale-free, unlike
 * `lstart`), Windows calls `GetProcessTimes` through `bun:ffi`. `undefined` means "could not be
 * read", never "the process is gone": the caller checks liveness separately.
 */

import { readFile } from 'node:fs/promises';

import { HIDDEN_WINDOW } from '@mangostudio/shared/process';

import { readWindowsCreationFileTime } from './windows-process-times';

/** Linux `USER_HZ`: the unit of `/proc/<pid>/stat` field 22, fixed by the kernel ABI. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/** A query that hangs must not hang `stop`; the CLI falls back to "unconfirmed". */
const QUERY_TIMEOUT_MS = 5_000;

/** `FILETIME` ticks (100 ns since 1601-01-01 UTC) at the Unix epoch, 1970-01-01 UTC. */
const FILETIME_TICKS_AT_UNIX_EPOCH = 116_444_736_000_000_000n;

/** .NET `DateTime` ticks (100 ns since 0001-01-01 UTC) at 1601-01-01 UTC. */
const DOTNET_TICKS_AT_FILETIME_EPOCH = 504_911_232_000_000_000n;

const FILETIME_TICKS_PER_MS = 10_000n;

export interface ProcessStartTimeHost {
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly readText: (path: string) => Promise<string>;
  /**
   * Windows only: the creation time of `pid` as a `FILETIME` (100 ns ticks since 1601-01-01
   * UTC), or `undefined` when the process cannot be opened or queried.
   */
  readonly readWindowsCreationTime: (pid: number) => Promise<bigint | undefined>;
  /**
   * Runs a command and returns its stdout, or `undefined` when it failed or timed out.
   * `env` entries are added to this process's environment.
   */
  readonly run: (
    command: readonly string[],
    env?: Readonly<Record<string, string>>
  ) => Promise<string | undefined>;
}

/**
 * Start time (epoch ms) from the text of `/proc/<pid>/stat` and `/proc/uptime`.
 * The process age is the system uptime minus the start tick, so no boot time and
 * no clock other than `now` is involved.
 *
 * @example
 * linuxStartMs(await readFile('/proc/42/stat', 'utf8'), await readFile('/proc/uptime', 'utf8'), Date.now());
 */
export function linuxStartMs(stat: string, uptime: string, now: number): number | undefined {
  // `comm` is parenthesised and may hold spaces or parentheses: fields start after the last `)`.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // Field 22 overall; the slice starts at field 3 (state).
  const startTicks = Number(fields[19]);
  const uptimeSeconds = Number(uptime.split(' ')[0]);
  if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds)) return undefined;
  const ageSeconds = uptimeSeconds - startTicks / LINUX_CLOCK_TICKS_PER_SECOND;
  return Math.round(now - ageSeconds * 1000);
}

/**
 * Start time (epoch ms) from `ps -o etime=` output: `[[dd-]hh:]mm:ss`.
 *
 * @example
 * psElapsedStartMs('1-02:03:04\n', 1_000_000_000); // now minus 93784 s
 */
export function psElapsedStartMs(output: string, now: number): number | undefined {
  const match = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(output);
  if (!match) return undefined;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  const elapsedSeconds =
    Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
  return now - elapsedSeconds * 1000;
}

/**
 * Epoch milliseconds from a Windows `FILETIME`, rounded half up to the millisecond, or
 * `undefined` for a value before 1970 (a zero or garbage buffer, never a real process start).
 * `bigint` throughout: a current `FILETIME` is about 1.3e17, past what a double holds exactly.
 *
 * @example
 * fileTimeToEpochMs(116_444_736_000_000_000n); // 0
 */
export function fileTimeToEpochMs(fileTime: bigint): number | undefined {
  if (fileTime < FILETIME_TICKS_AT_UNIX_EPOCH) return undefined;
  const sinceUnixEpoch = fileTime - FILETIME_TICKS_AT_UNIX_EPOCH;
  return Number((sinceUnixEpoch + FILETIME_TICKS_PER_MS / 2n) / FILETIME_TICKS_PER_MS);
}

/**
 * The .NET `DateTime` ticks (UTC) of a Windows `FILETIME`, as the decimal text
 * `(Get-Process).StartTime.ToUniversalTime().Ticks` printed, so a start token written by a hub
 * from before the native read still compares equal. `undefined` for a non-positive value.
 *
 * @example
 * fileTimeToDotNetTicks(1n); // '504911232000000001'
 */
export function fileTimeToDotNetTicks(fileTime: bigint): string | undefined {
  return fileTime > 0n ? String(fileTime + DOTNET_TICKS_AT_FILETIME_EPOCH) : undefined;
}

/**
 * The start time of `pid` as epoch milliseconds, or `undefined` when the platform
 * query failed or `pid` is not a positive integer.
 *
 * @example
 * await readProcessStartMs(process.pid); // about Date.now() - process.uptime() * 1000
 */
export async function readProcessStartMs(
  pid: number,
  host: ProcessStartTimeHost = REAL_START_TIME_HOST
): Promise<number | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 2) return undefined;
  try {
    if (host.platform === 'linux') {
      const [stat, uptime] = await Promise.all([
        host.readText(`/proc/${pid}/stat`),
        host.readText('/proc/uptime'),
      ]);
      return linuxStartMs(stat, uptime, host.now());
    }
    if (host.platform === 'win32') {
      const fileTime = await host.readWindowsCreationTime(pid);
      return fileTime === undefined ? undefined : fileTimeToEpochMs(fileTime);
    }
    const output = await host.run(['ps', '-o', 'etime=', '-p', String(pid)]);
    return output === undefined ? undefined : psElapsedStartMs(output, host.now());
  } catch {
    return undefined;
  }
}

export const REAL_START_TIME_HOST: ProcessStartTimeHost = {
  platform: process.platform,
  now: Date.now,
  readText: (path) => readFile(path, 'utf8'),
  readWindowsCreationTime: readWindowsCreationFileTime,
  run: async (command, env) => {
    const child = Bun.spawn([...command], {
      env: { ...process.env, ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: QUERY_TIMEOUT_MS,
      ...HIDDEN_WINDOW,
    });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return exitCode === 0 ? stdout : undefined;
  },
};
