/**
 * An opaque token that identifies one process incarnation, for equality only. The hub writes its
 * own into the state file and the CLI reads the token of the pid the file names: equal means the
 * same process, different means another process reused the pid. No clock arithmetic is involved,
 * so a wall-clock step (NTP after boot, a resumed VM) cannot change the answer.
 *
 * - Linux: `<boot_id>:<start ticks>`. Field 22 of `/proc/<pid>/stat` counts ticks since boot, and
 *   `boot_id` makes ticks from different boots differ.
 * - macOS: the `ps -o lstart=` text, the kernel's stored start time, read with `LC_ALL=C`.
 * - Windows: the process `StartTime` as .NET ticks, from one PowerShell query.
 *
 * `undefined` means "could not be read", never "the process is gone".
 */

import { type ProcessStartTimeHost, REAL_START_TIME_HOST } from './process-start-time';

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
      const output = await host.run([
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ]);
      const ticks = output?.trim();
      return ticks !== undefined && /^\d{10,}$/.test(ticks) ? ticks : undefined;
    }
    // `lstart` prints local time; the C locale keeps its shape (and so equality) stable.
    const output = await host.run(['ps', '-o', 'lstart=', '-p', String(pid)], { LC_ALL: 'C' });
    const started = output?.trim();
    return started !== undefined &&
      /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(started)
      ? started
      : undefined;
  } catch {
    return undefined;
  }
}
