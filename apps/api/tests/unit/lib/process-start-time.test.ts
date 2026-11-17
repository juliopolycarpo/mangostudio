import { describe, expect, it } from 'bun:test';

import {
  linuxStartMs,
  type ProcessStartTimeHost,
  psElapsedStartMs,
  readProcessStartMs,
  windowsStartMs,
} from '../../../src/lib/process-start-time';

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

describe('windowsStartMs', () => {
  it('reads Unix milliseconds', () => {
    expect(windowsStartMs('1700000000123\r\n')).toBe(1_700_000_000_123);
  });

  it.each(['', 'Get-Process : Cannot find a process', '17e9'])(
    'returns undefined for %p',
    (out) => {
      expect(windowsStartMs(out)).toBeUndefined();
    }
  );
});

/** A host that serves canned files and command output, and records what it was asked. */
class FakeStartTimeHost implements ProcessStartTimeHost {
  readonly commands: string[][] = [];
  readonly reads: string[] = [];
  constructor(
    readonly platform: NodeJS.Platform,
    private readonly files: Record<string, string> = {},
    private readonly commandOutput: string | undefined = undefined
  ) {}
  now = () => NOW;
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

  it('asks PowerShell on Windows', async () => {
    const host = new FakeStartTimeHost('win32', {}, '1699999999000\r\n');
    expect(await readProcessStartMs(42, host)).toBe(1_699_999_999_000);
    expect(host.commands[0]?.[0]).toBe('powershell.exe');
    expect(host.commands[0]?.at(-1)).toContain('Get-Process -Id 42');
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
    // ps and Get-Process resolve to a second; allow the query's own latency too.
    expect(Math.abs((started ?? 0) - expected)).toBeLessThan(3_000);
  });
});
