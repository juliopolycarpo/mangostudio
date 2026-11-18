/**
 * An opaque token that identifies one process incarnation, for equality only. The hub writes its
 * own into the state file and the CLI reads the token of the pid the file names: equal means the
 * same process, different means another process reused the pid. No clock arithmetic is involved,
 * so a wall-clock step (NTP after boot, a resumed VM) cannot change the answer.
 *
 * - Linux: `<boot_id>:<start ticks>`. Field 22 of `/proc/<pid>/stat` counts ticks since boot, and
 *   `boot_id` makes ticks from different boots differ.
 * - macOS: the `ps -o lstart=` text, the kernel's stored start time, read with `LC_ALL=C`.
 *   It has one-second resolution (a runner showed a test process and its parent sharing one), so
 *   two processes started within the same second share a token. A recycled pid would be accepted
 *   only if the hub exited and the OS reused its pid inside the hub's own start second, which
 *   needs a full pid wrap in under a second. That is accepted rather than paid for: the only
 *   finer source, the `kern.proc.pid` sysctl, returns a binary struct the `sysctl` tool does
 *   not decode, and reading it needs a native call this module avoids.
 * - Windows: the process creation time as .NET ticks (UTC), from `GetProcessTimes` through
 *   `bun:ffi`. The text is what the PowerShell query this replaced printed, so tokens already
 *   in a state file still compare equal.
 *
 * `undefined` means "could not be read", never "the process is gone".
 */

import {
  fileTimeToDotNetTicks,
  type ProcessStartTimeHost,
  REAL_START_TIME_HOST,
} from './process-start-time';

/**
 * Field 22 (start ticks) of `/proc/<pid>/stat` text. `comm`, field 2, is parenthesised and may
 * itself hold spaces and parentheses, so the fields start after the last `)`.
 *
 * @example
 * linuxStartTicks('42 (a) (b c) S 1 42 42 0 -1 ...'); // field 22 as a string
 */
export function linuxStartTicks(stat: string): string | undefined {
  // The slice starts at field 3 (state); field 22 is therefore index 19.
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : undefined;
}

/**
 * The token for `pid`, or `undefined` when the platform query failed or `pid` is not a positive
 * integer above 1.
 *
 * @example
 * await readProcessStartToken(process.pid); // '8c1e…:123456' on Linux
 */
export async function readProcessStartToken(
  pid: number,
  host: ProcessStartTimeHost = REAL_START_TIME_HOST
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 2) return undefined;
  try {
    if (host.platform === 'linux') {
      const [stat, bootId] = await Promise.all([
        host.readText(`/proc/${pid}/stat`),
        host.readText('/proc/sys/kernel/random/boot_id'),
      ]);
      const ticks = linuxStartTicks(stat);
      const boot = bootId.trim();
      return ticks === undefined || boot === '' ? undefined : `${boot}:${ticks}`;
    }
    if (host.platform === 'win32') {
      const fileTime = await host.readWindowsCreationTime(pid);
      return fileTime === undefined ? undefined : fileTimeToDotNetTicks(fileTime);
    }
    // `lstart` prints the start instant in the caller's time zone and locale. The hub (often a
    // launchd service) and the CLI (a shell that may set `TZ`, or a laptop whose zone changed
    // since the hub started) must print the same text for the same instant, so both are pinned.
    const output = await host.run(['ps', '-o', 'lstart=', '-p', String(pid)], {
      LC_ALL: 'C',
      TZ: 'UTC',
    });
    const started = output?.trim();
    return started !== undefined &&
      /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(started)
      ? started
      : undefined;
  } catch {
    return undefined;
  }
}
