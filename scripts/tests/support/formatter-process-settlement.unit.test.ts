import { describe, expect, it } from 'bun:test';
import {
  type FormatterNativeQueries,
  type FormatterSettlementHost,
  type NativeFormatterProcess,
  readNativeFormatterProcess,
  waitForFormatterSettlement,
} from './formatter-process-settlement';

/** A native query transcript with no process signaling capability. */
class NativeQueryTranscript implements FormatterNativeQueries {
  readonly calls: Array<[string, number, number]> = [];
  stat: string | undefined;
  result = { exitCode: 0, stdout: '', stderr: '' };
  failure: Error | undefined;
  constructor(readonly platform: NodeJS.Platform) {}
  readStat(pid: number, timeout: number): Promise<string | undefined> {
    this.calls.push(['stat', pid, timeout]);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.stat);
  }
  query(pid: number, timeout: number) {
    this.calls.push(['ps', pid, timeout]);
    return Promise.resolve(this.result);
  }
}

function linuxStat(state = 'S', birth = '12345'): string {
  const fields = Array<string>(20).fill('0');
  fields[0] = state;
  fields[1] = '100';
  fields[2] = '1234';
  fields[19] = birth;
  return `1234 (formatter (with spaces)) ${fields.join(' ')}`;
}

const native: NativeFormatterProcess = {
  pid: 1234,
  parentPid: 100,
  group: 1234,
  identity: '1234:12345',
  command: '',
  state: 'S',
};

class NativeSettlementClock implements FormatterSettlementHost {
  time = 0;
  readonly reads: Array<[number, number]> = [];
  readonly current = new Map<number, NativeFormatterProcess | undefined>([[1234, native]]);
  failure: Error | undefined;
  now = () => this.time;
  pause = (ms: number): Promise<void> => {
    this.time += ms;
    return Promise.resolve();
  };
  read = (pid: number, budget: number): Promise<NativeFormatterProcess | undefined> => {
    this.reads.push([pid, budget]);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.current.get(pid));
  };
}

const owned = [{ who: 'controlled formatter', native }];

describe('native formatter identity queries', () => {
  it('captures Linux birth/state/lineage from one native document', async () => {
    const queries = new NativeQueryTranscript('linux');
    queries.stat = linuxStat();
    expect(await readNativeFormatterProcess(1234, 300, queries)).toEqual(native);
    expect(queries.calls).toEqual([['stat', 1234, 300]]);
  });
  it('keeps absence distinct from failed or malformed Linux reads', async () => {
    const queries = new NativeQueryTranscript('linux');
    expect(await readNativeFormatterProcess(1234, 300, queries)).toBeUndefined();
    queries.failure = new Error('controlled native stat permission failure');
    await expect(readNativeFormatterProcess(1234, 300, queries)).rejects.toBe(queries.failure);
    queries.failure = undefined;
    queries.stat = linuxStat('?', '12345');
    await expect(readNativeFormatterProcess(1234, 300, queries)).rejects.toThrow(
      'expected a process state letter'
    );
    queries.stat = linuxStat('S', 'not-ticks');
    await expect(readNativeFormatterProcess(1234, 300, queries)).rejects.toThrow(
      'expected decimal digits'
    );
  });
  it('refuses malformed native lineage even when the birth field is present', async () => {
    const queries = new NativeQueryTranscript('linux');
    queries.stat = linuxStat().replace(' S 100 1234 ', ' S invalid 1234 ');
    await expect(readNativeFormatterProcess(1234, 300, queries)).rejects.toThrow(
      'expected native integer parent/group'
    );
  });
  it('keeps the macOS POSIX path and captures creation time with native state', async () => {
    const queries = new NativeQueryTranscript('darwin');
    queries.result.stdout = '1234 100 1234 S+ Sun Oct 25 10:00:00 2026 rustfmt file.rs';
    const current = await readNativeFormatterProcess(1234, 300, queries);
    expect(current).toEqual({
      ...native,
      command: 'rustfmt file.rs',
      identity: '1234:Sun Oct 25 10:00:00 2026',
    });
    expect(queries.calls).toEqual([['ps', 1234, 300]]);
  });
  it.each([
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'permission refused' },
    { exitCode: 143, stdout: '', stderr: '' },
    { exitCode: 0, stdout: 'malformed native output', stderr: '' },
    { exitCode: 0, stdout: '1234 100 1234 S Sun Bad 25 10:00:00 2026 rustfmt', stderr: '' },
    { exitCode: 0, stdout: '1235 100 1235 S Sun Oct 25 10:00:00 2026 other', stderr: '' },
  ])('refuses an unproven POSIX query: %j', async (result) => {
    const queries = new NativeQueryTranscript('darwin');
    queries.result = result;
    await expect(readNativeFormatterProcess(1234, 300, queries)).rejects.toThrow('expected');
  });
  it('recognizes only the native absent-process result as absent', async () => {
    const queries = new NativeQueryTranscript('darwin');
    queries.result.exitCode = 1;
    expect(await readNativeFormatterProcess(1234, 300, queries)).toBeUndefined();
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid PID %s', async (pid) => {
    await expect(readNativeFormatterProcess(pid)).rejects.toThrow('positive safe integer');
  });
  it.each([0, -1, 301, 1.5])(
    'refuses a changed or invalid observation budget %s',
    async (budget) => {
      await expect(readNativeFormatterProcess(1234, budget)).rejects.toThrow(
        'expected an integer from 1 to 300ms'
      );
    }
  );
  it('does not add a Linux-only verdict to Windows', async () => {
    const queries = new NativeQueryTranscript('win32');
    await expect(readNativeFormatterProcess(1234, 300, queries)).rejects.toThrow('expected POSIX');
    expect(queries.calls).toEqual([]);
  });
});

describe('native formatter settlement', () => {
  it.each(['absent', 'replaced birth', 'zombie'] as const)(
    'accepts owned settlement: %s',
    async (mode) => {
      const clock = new NativeSettlementClock();
      clock.current.set(
        1234,
        mode === 'absent'
          ? undefined
          : {
              ...native,
              identity: mode === 'replaced birth' ? '1234:new-birth' : native.identity,
              state: mode === 'zombie' ? 'Z' : 'S',
            }
      );
      await waitForFormatterSettlement(owned, clock);
      expect(clock.time).toBe(0);
    }
  );
  it('rejects a quiet native survivor within the unchanged 300ms budget', async () => {
    const clock = new NativeSettlementClock();
    await expect(waitForFormatterSettlement(owned, clock)).rejects.toThrow(
      'expected live owned processes: 0 within 300ms'
    );
    expect(clock.time).toBe(300);
    expect(clock.reads.every(([, budget]) => budget >= 1 && budget <= 300)).toBe(true);
  });
  it('surfaces native query failures rather than reporting an empty census', async () => {
    const clock = new NativeSettlementClock();
    clock.failure = new Error('controlled unreadable native process');
    await expect(waitForFormatterSettlement(owned, clock)).rejects.toThrow(
      'native observation failed'
    );
  });
});
