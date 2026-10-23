import { describe, expect, it } from 'bun:test';
import {
  linuxProcessResourceUnits,
  type ProcessResourceFiles,
  readLinuxProcessResources,
} from '../lib/process-resource-host';

class FakeProcFiles implements ProcessResourceFiles {
  readonly requested: number[] = [];

  constructor(private readonly records: Readonly<Record<string, string | Error>>) {}

  names = (): Promise<readonly string[]> => Promise.resolve(Object.keys(this.records));

  stat = (pid: number): Promise<string> => {
    this.requested.push(pid);
    const record = this.records[String(pid)];
    if (record instanceof Error) return Promise.reject(record);
    if (record === undefined) {
      return Promise.reject(new Error(`FakeProcFiles: expected a record for pid ${pid}`));
    }
    return Promise.resolve(record);
  };
}

function statLine(pid = 42): string {
  const fields = Array.from({ length: 22 }, () => '0');
  fields[0] = 'S';
  fields[1] = '1';
  fields[2] = '42';
  fields[19] = '123';
  fields[21] = '4';
  return `${pid} (runtime) ${fields.join(' ')}`;
}

function procError(code: string): Error {
  return Object.assign(new Error(`Synthetic procfs failure ${code}`), { code });
}

describe('Linux process resource census', () => {
  it('reads only positive numeric pid entries', async () => {
    const files = new FakeProcFiles({
      '42': statLine(),
      self: 'ignored',
      '0': 'ignored',
      '1junk': 'ignored',
    });
    expect(await readLinuxProcessResources(4096, files)).toEqual([
      {
        pid: 42,
        parentPid: 1,
        group: 42,
        command: 'runtime',
        startTicks: 123,
        userTicks: 0,
        systemTicks: 0,
        rssBytes: 16384,
      },
    ]);
    expect(files.requested).toEqual([42]);
  });

  it.each(['ENOENT', 'ESRCH'])(
    'omits a process that exited with %s during observation',
    async (code) => {
      const files = new FakeProcFiles({ '42': statLine(), '43': procError(code) });
      expect(await readLinuxProcessResources(4096, files)).toHaveLength(1);
    }
  );

  it.each(['EACCES', 'EIO'])(
    'preserves %s instead of returning an empty green census',
    async (code) => {
      const files = new FakeProcFiles({ '42': procError(code) });
      await expect(readLinuxProcessResources(4096, files)).rejects.toMatchObject({ code });
    }
  );

  it('rejects malformed stat data', async () => {
    const files = new FakeProcFiles({ '42': 'malformed' });
    await expect(readLinuxProcessResources(4096, files)).rejects.toThrow(
      'expected matching pid (comm) fields'
    );
  });
});

class FakeGetconf {
  readonly names: string[] = [];
  constructor(private readonly values: Record<string, string>) {}
  capture = (name: string): string => {
    this.names.push(name);
    return this.values[name] ?? '';
  };
}

describe('Linux resource counter units', () => {
  it('uses host page size and clock frequency without assuming either', () => {
    const host = new FakeGetconf({ PAGESIZE: '16384', CLK_TCK: '250' });
    expect(linuxProcessResourceUnits(host.capture)).toEqual({
      pageBytes: 16384,
      ticksPerSecond: 250,
    });
    expect(host.names).toEqual(['PAGESIZE', 'CLK_TCK']);
  });
  it.each(['', '0', '-1', 'NaN', '1.5'])('rejects invalid unit %s', (unit) => {
    const host = new FakeGetconf({ PAGESIZE: unit, CLK_TCK: '100' });
    expect(() => linuxProcessResourceUnits(host.capture)).toThrow(
      'getconf PAGESIZE: expected a positive safe integer'
    );
  });
});
