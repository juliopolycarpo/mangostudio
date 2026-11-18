import { describe, expect, it } from 'bun:test';

import {
  fileTimeToDotNetTicks,
  fileTimeToEpochMs,
  linuxStartMs,
  type ProcessStartTimeHost,
  psElapsedStartMs,
  readProcessStartMs,
} from '../../../src/lib/process-start-time';
import { readWindowsCreationFileTime } from '../../../src/lib/windows-process-times';

const NOW = 1_700_000_000_000;

/** `/proc/<pid>/stat` with `startTicks` as field 22 and a hostile `comm`. */
function statWithStartTicks(startTicks: number, comm = 'bun (x) y'): string {
  const afterComm = Array.from({ length: 50 }, (_, index) => String(index + 3));
  afterComm[0] = 'S';
  afterComm[19] = String(startTicks);
  return `42 (${comm}) ${afterComm.join(' ')}`;
}

describe('linuxStartMs', () => {
  it('derives the start from the uptime and the start tick', () => {
    // Up 1000 s, process started at tick 30000 (300 s): 700 s old.
    expect(linuxStartMs(statWithStartTicks(30_000), '1000.00 5.00', NOW)).toBe(NOW - 700_000);
  });

  it('is not confused by parentheses and spaces in the command name', () => {
    expect(linuxStartMs(statWithStartTicks(30_000, 'a) (b c'), '1000.00 5.00', NOW)).toBe(
      NOW - 700_000
    );
  });

  it.each(['', 'garbage', '42 (x) S'])('returns undefined for stat text %p', (stat) => {
    expect(linuxStartMs(stat, '1000.00 5.00', NOW)).toBeUndefined();
  });

  it('returns undefined for an unreadable uptime', () => {
    expect(linuxStartMs(statWithStartTicks(1), 'n/a', NOW)).toBeUndefined();
  });
});

describe('psElapsedStartMs', () => {
  it.each([
    ['05:07', 307],
    ['  01:02:03\n', 3_723],
    ['2-00:00:09', 172_809],
  ])('reads elapsed %p as %p seconds', (output, seconds) => {
    expect(psElapsedStartMs(output, NOW)).toBe(NOW - seconds * 1000);
  });

  it.each(['', 'ELAPSED', '12', '1:2:3:4', 'x-01:02'])('returns undefined for %p', (output) => {
    expect(psElapsedStartMs(output, NOW)).toBeUndefined();
  });
});

/** `FILETIME` ticks at 1970-01-01 UTC: the 1601 epoch plus 11,644,473,600 s in 100 ns ticks. */
const FILETIME_AT_UNIX_EPOCH = 116_444_736_000_000_000n;

describe('fileTimeToEpochMs', () => {
  it('maps the Unix epoch to zero, which pins the 1601 offset', () => {
    expect(fileTimeToEpochMs(FILETIME_AT_UNIX_EPOCH)).toBe(0);
  });

  it('maps a known instant: 2023-11-14T22:13:20Z is 1_700_000_000_000 ms', () => {
    expect(fileTimeToEpochMs(FILETIME_AT_UNIX_EPOCH + 1_700_000_000_000n * 10_000n)).toBe(
      1_700_000_000_000
    );
  });

  it('keeps the millisecond exact where a double would lose ticks', () => {
    // 1.3e17 ticks is past 2^53: one tick short of the next millisecond must still round up to
    // it, and one tick past the previous must still round down.
    const base = FILETIME_AT_UNIX_EPOCH + 1_700_000_000_123n * 10_000n;
    expect(fileTimeToEpochMs(base - 1n)).toBe(1_700_000_000_123);
    expect(fileTimeToEpochMs(base + 1n)).toBe(1_700_000_000_123);
  });

  it.each([
    [4_999n, 0],
    [5_000n, 1],
    [14_999n, 1],
    [15_000n, 2],
  ])('rounds %p ticks past a millisecond half up to %p ms', (ticks, expected) => {
    expect(fileTimeToEpochMs(FILETIME_AT_UNIX_EPOCH + ticks)).toBe(expected);
  });

  it.each([0n, 1n, -1n, FILETIME_AT_UNIX_EPOCH - 1n])(
    'is undefined for %p, before 1970 and so not a real process start',
    (fileTime) => {
      expect(fileTimeToEpochMs(fileTime)).toBeUndefined();
    }
  );
});

describe('fileTimeToDotNetTicks', () => {
  it('adds the 1601 to 0001 offset, as the decimal text PowerShell printed', () => {
    expect(fileTimeToDotNetTicks(1n)).toBe('504911232000000001');
    // The Unix epoch in .NET ticks, a constant every .NET reference lists.
    expect(fileTimeToDotNetTicks(FILETIME_AT_UNIX_EPOCH)).toBe('621355968000000000');
  });

  it.each([0n, -1n])('is undefined for %p', (fileTime) => {
    expect(fileTimeToDotNetTicks(fileTime)).toBeUndefined();
  });
});

/** A host that serves canned files, command output and a creation time, and records what it was asked. */
class FakeStartTimeHost implements ProcessStartTimeHost {
  readonly commands: string[][] = [];
  readonly reads: string[] = [];
  readonly creationTimeQueries: number[] = [];
  constructor(
    readonly platform: NodeJS.Platform,
    private readonly files: Record<string, string> = {},
    private readonly commandOutput: string | undefined = undefined,
    private readonly windowsCreationTime: bigint | undefined = undefined
  ) {}
  now = () => NOW;
  readWindowsCreationTime = (pid: number): Promise<bigint | undefined> => {
    this.creationTimeQueries.push(pid);
    return Promise.resolve(this.windowsCreationTime);
  };
  readText = (path: string): Promise<string> => {
    this.reads.push(path);
    const text = this.files[path];
    return text === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(text);
  };
  run = (command: readonly string[]): Promise<string | undefined> => {
    this.commands.push([...command]);
    return Promise.resolve(this.commandOutput);
  };
}

describe('readProcessStartMs', () => {
  it('reads /proc on Linux', async () => {
    const host = new FakeStartTimeHost('linux', {
      '/proc/42/stat': statWithStartTicks(30_000),
      '/proc/uptime': '1000.00 5.00',
    });
    expect(await readProcessStartMs(42, host)).toBe(NOW - 700_000);
    expect(host.commands).toEqual([]);
  });

  it('asks ps for the elapsed time on macOS', async () => {
    const host = new FakeStartTimeHost('darwin', {}, '01:00\n');
    expect(await readProcessStartMs(42, host)).toBe(NOW - 60_000);
    expect(host.commands).toEqual([['ps', '-o', 'etime=', '-p', '42']]);
  });

  it('converts the native creation time on Windows, with no spawn', async () => {
    const host = new FakeStartTimeHost(
      'win32',
      {},
      undefined,
      FILETIME_AT_UNIX_EPOCH + 1_699_999_999_000n * 10_000n
    );
    expect(await readProcessStartMs(42, host)).toBe(1_699_999_999_000);
    expect(host.creationTimeQueries).toEqual([42]);
    expect(host.commands).toEqual([]);
  });

  it('is undefined on Windows when the process cannot be opened or queried', async () => {
    const host = new FakeStartTimeHost('win32');
    expect(await readProcessStartMs(42, host)).toBeUndefined();
    expect(host.creationTimeQueries).toEqual([42]);
  });

  it('is undefined on Windows when the native read throws, as when kernel32 cannot load', async () => {
    const throwing: ProcessStartTimeHost = {
      ...new FakeStartTimeHost('win32'),
      readWindowsCreationTime: () => Promise.reject(new Error('dlopen kernel32.dll failed')),
    };
    expect(await readProcessStartMs(42, throwing)).toBeUndefined();
  });

  it('is undefined when the query fails', async () => {
    expect(await readProcessStartMs(42, new FakeStartTimeHost('darwin', {}, undefined))).toBe(
      undefined
    );
    expect(await readProcessStartMs(42, new FakeStartTimeHost('linux'))).toBe(undefined);
  });

  it.each([0, 1, -1, Number.NaN, 1.5])('never queries for pid %p', async (pid) => {
    const host = new FakeStartTimeHost('darwin', {}, '01:00');
    expect(await readProcessStartMs(pid, host)).toBeUndefined();
    expect(host.commands).toEqual([]);
  });

  it('reads this process as having started about process.uptime() ago, on this platform', async () => {
    const started = await readProcessStartMs(process.pid);
    const expected = Date.now() - process.uptime() * 1000;

    expect(started, 'expected a start time for this process | received: undefined').toBeDefined();
    // ps resolves to a second, and Bun starts its uptime clock a little after the OS creates the
    // process. The Windows read is a microsecond native call, so this bounds the clocks, not a query.
    expect(Math.abs((started ?? 0) - expected)).toBeLessThan(3_000);
  });
});

describe('readWindowsCreationFileTime', () => {
  const onWindows = process.platform === 'win32' ? it : it.skip;

  onWindows('reads this process as created about process.uptime() ago', async () => {
    const fileTime = await readWindowsCreationFileTime(process.pid);
    const expected = Date.now() - process.uptime() * 1000;

    expect(fileTime, 'expected a FILETIME for this process | received: undefined').toBeDefined();
    expect(Math.abs((fileTimeToEpochMs(fileTime ?? 0n) ?? 0) - expected)).toBeLessThan(3_000);
  });

  onWindows('is undefined for a pid no process holds', async () => {
    // Pids are multiples of four and this one is far above any a runner reaches.
    expect(await readWindowsCreationFileTime(0x7ffffffc)).toBeUndefined();
  });
});
