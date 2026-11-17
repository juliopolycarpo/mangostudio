/**
 * When a process started, read from the operating system without a native
 * dependency. The hub's CLI uses it to tell the hub apart from an unrelated
 * process that reused the hub's pid after the hub died (see `server-state.ts`).
 *
 * Linux reads `/proc`, macOS asks `ps` for the elapsed time (locale-free, unlike
 * `lstart`), Windows asks PowerShell. `undefined` means "could not be read", never
 * "the process is gone": the caller checks liveness separately.
 */

import { readFile } from 'node:fs/promises';

import { HIDDEN_WINDOW } from '@mangostudio/shared/process';

/** Linux `USER_HZ`: the unit of `/proc/<pid>/stat` field 22, fixed by the kernel ABI. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/** A query that hangs must not hang `stop`; the CLI falls back to "unconfirmed". */
const QUERY_TIMEOUT_MS = 5_000;

export interface ProcessStartTimeHost {
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly readText: (path: string) => Promise<string>;
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

/** Start time (epoch ms) from the Unix milliseconds PowerShell printed, or `undefined`. */
export function windowsStartMs(output: string): number | undefined {
  const text = output.trim();
  return /^\d{10,}$/.test(text) ? Number(text) : undefined;
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
      const output = await host.run([
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`,
      ]);
      return output === undefined ? undefined : windowsStartMs(output);
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
