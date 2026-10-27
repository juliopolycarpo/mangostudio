import { describe, expect, it } from 'bun:test';

import { FormatterQueryExpiry } from './formatter-owned-query';
import {
  type FormatterStatHost,
  FormatterStatReadExpiry,
  readOwnedFormatterStat,
} from './formatter-owned-stat';
import {
  type FormatterNativeQueries,
  type FormatterSettlementHost,
  type NativeFormatterProcess,
  readNativeFormatterProcess,
  waitForFormatterSettlement,
} from './formatter-process-settlement';

type NativeQueryReply = Awaited<ReturnType<FormatterNativeQueries['query']>>;

/** A native query transcript with no process signaling capability. */
class NativeQueryTranscript implements FormatterNativeQueries {
  readonly calls: Array<[string, number, number]> = [];
  stat: string | undefined;
  result: { -readonly [Field in keyof NativeQueryReply]: NativeQueryReply[Field] } = {
    exitCode: 0,
    stdout: '',
    stderr: '',
  };
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

/** A timed native transcript that refuses queries admitted after its deadline. */
class TimedNativeSettlementTranscript extends NativeSettlementClock {
  readonly admissions: Array<{ at: number; budget: number }> = [];
  pauseOverrun = 0;
  readonly pauseDurations: number[] = [];
  readDuration = 0;
  failureDuration = 0;
  nowReadAdvance = 0;
  rejectFrom = Number.POSITIVE_INFINITY;
  readonly queryFailure = new Error('controlled native observation refusal');
  readonly failuresByPid = new Map<number, Error>();
  override now = (): number => {
    const current = this.time;
    this.time += this.nowReadAdvance;
    return current;
  };
  override pause = (ms: number): Promise<void> => {
    this.time += this.pauseDurations.shift() ?? ms + this.pauseOverrun;
    return Promise.resolve();
  };
  override read = (pid: number, budget: number): Promise<NativeFormatterProcess | undefined> => {
    const admittedAt = this.time;
    this.admissions.push({ at: admittedAt, budget });
    this.reads.push([pid, budget]);
    this.time += this.readDuration;
    if (admittedAt >= 300 || admittedAt >= this.rejectFrom) {
      this.time += this.failureDuration;
      return Promise.reject(this.failuresByPid.get(pid) ?? this.queryFailure);
    }
    return Promise.resolve(this.current.get(pid));
  };
}

/** A valid live sample followed by a successful native read delivered after expiry. */
class LateNativeFulfillmentTranscript extends NativeSettlementClock {
  constructor(readonly lateResult: NativeFormatterProcess | undefined) {
    super();
  }
  override read = (pid: number, budget: number): Promise<NativeFormatterProcess | undefined> => {
    this.reads.push([pid, budget]);
    if (this.reads.length === 1) return Promise.resolve(this.current.get(pid));
    this.time += 300;
    return Promise.resolve(this.lateResult);
  };
}

/** A complete census followed by the private query budget event, never a new sample. */
class OwnedExpirySettlementClock extends NativeSettlementClock {
  readonly expiryReason = new Error('controlled private query expiry');
  readonly expiries: FormatterQueryExpiry[] = [];
  firstReadExpires = false;
  expiryDuration = 300;
  wrongPid = false;
  wrongBudget = false;
  pauseFailure: Error | undefined;
  readonly pauseDurations: number[] = [];
  readonly negativePauseFailure = new Error('controlled negative remaining wait');
  expiryNowCalls = 0;
  advanceOnExpiryNowCall = Number.POSITIVE_INFINITY;
  override now = (): number => {
    const current = this.time;
    if (this.expiries.length && ++this.expiryNowCalls === this.advanceOnExpiryNowCall)
      this.time += 1;
    return current;
  };
  override read = (pid: number, budget: number): Promise<NativeFormatterProcess | undefined> => {
    this.reads.push([pid, budget]);
    if (!this.firstReadExpires && this.reads.length === 1) return Promise.resolve(native);
    this.time += this.expiryDuration;
    const error = new FormatterQueryExpiry(
      this.wrongPid ? pid + 1 : pid,
      this.wrongBudget ? budget + 1 : budget,
      { exitCode: 143, stdout: '', stderr: '', signalCode: 'SIGTERM' },
      this.expiryReason
    );
    this.expiries.push(error);
    return Promise.reject(error);
  };
  override pause = (ms: number): Promise<void> => {
    this.pauseDurations.push(ms);
    if (ms < 0) return Promise.reject(this.negativePauseFailure);
    if (this.expiries.length && this.pauseFailure) return Promise.reject(this.pauseFailure);
    this.time += ms;
    return Promise.resolve();
  };
}

/** An independent second query refusal must prevent the expiry-only verdict. */
class MixedExpirySettlementClock extends NativeSettlementClock {
  readonly independentFailure = new Error('controlled second native query refusal');
  readonly expiry = new FormatterQueryExpiry(
    1234,
    300,
    { exitCode: 143, stdout: '', stderr: '', signalCode: 'SIGTERM' },
    new Error('controlled private query expiry')
  );
  override read = (pid: number, budget: number): Promise<NativeFormatterProcess | undefined> => {
    this.reads.push([pid, budget]);
    return Promise.reject(pid === 1234 ? this.expiry : this.independentFailure);
  };
}

/** A real owned-stat adapter driven by a named private-abort transcript. */
class ExpiringStatHost implements FormatterStatHost {
  readonly controller = new AbortController();
  readonly reason = new Error('controlled stat deadline');
  readonly failure = Object.assign(new Error('The operation was aborted', { cause: this.reason }), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
  timeout(): AbortSignal {
    return this.controller.signal;
  }
  read(): Promise<string> {
    this.controller.abort(this.reason);
    return Promise.reject(this.failure);
  }
  watchdog(): () => void {
    return () => {};
  }
}

/** Route a controlled stat through the real native identity reader. */
class ExpiringStatNativeQueries implements FormatterNativeQueries {
  readonly platform = 'linux' as const;
  constructor(
    readonly host: ExpiringStatHost,
    readonly wrongPid = false,
    readonly wrongBudget = false
  ) {}
  readStat(pid: number, budget: number): Promise<string | undefined> {
    return readOwnedFormatterStat(
      this.wrongPid ? pid + 1 : pid,
      this.wrongBudget ? budget - 1 : budget,
      this.host
    );
  }
  query(): Promise<NativeQueryReply> {
    throw new Error('unexpected POSIX ps query for Linux stat');
  }
}

class OwnedStatExpirySettlementClock extends NativeSettlementClock {
  readonly stat = new ExpiringStatHost();
  firstReadExpires = false;
  wrongPid = false;
  wrongBudget = false;
  expiry: unknown;
  override read = (pid: number, budget: number): Promise<NativeFormatterProcess | undefined> => {
    this.reads.push([pid, budget]);
    if (!this.firstReadExpires && this.reads.length === 1) return Promise.resolve(native);
    this.time += budget;
    return readNativeFormatterProcess(
      pid,
      budget,
      new ExpiringStatNativeQueries(this.stat, this.wrongPid, this.wrongBudget)
    ).then(
      () => {
        throw new Error('expected owned stat expiry');
      },
      (error: unknown) => {
        this.expiry = error;
        throw error;
      }
    );
  };
}

class MixedStatExpirySettlementClock extends NativeSettlementClock {
  readonly stat = new ExpiringStatHost();
  readonly independentFailure = new Error('controlled second stat refusal');
  expiry: unknown;
  override read = (pid: number, budget: number): Promise<NativeFormatterProcess | undefined> => {
    this.reads.push([pid, budget]);
    if (pid !== 1234) return Promise.reject(this.independentFailure);
    return readNativeFormatterProcess(pid, budget, new ExpiringStatNativeQueries(this.stat)).then(
      () => {
        throw new Error('expected owned stat expiry');
      },
      (error: unknown) => {
        this.expiry = error;
        throw error;
      }
    );
  };
}

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
  it('retains termination metadata without treating a signaled query as absence', async () => {
    const queries = new NativeQueryTranscript('darwin');
    queries.result = {
      exitCode: 143,
      stdout: '',
      stderr: '',
      signalCode: 'SIGTERM',
      killed: true,
    };
    const failure = await readNativeFormatterProcess(1234, 1, queries).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('expected native PID/parent/group/state/birth');
    const details = JSON.parse(message.split(' | received: ')[1] ?? 'null');
    expect(details).toMatchObject({ ...queries.result, timeoutMs: 1 });
    expect(details.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(queries.calls).toEqual([['ps', 1234, 1]]);
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
  it('retains the complete live census when the next owned stat read expires', async () => {
    const clock = new OwnedStatExpirySettlementClock();
    const error = await waitForFormatterSettlement(owned, clock).catch(
      (failure: unknown) => failure
    );
    expect((error as Error).message).toContain('expected live owned processes: 0 within 300ms');
    const snapshot = JSON.parse(
      (error as Error).message.split('received last native observation: ')[1] ?? 'null'
    );
    expect(snapshot).toEqual({ elapsedMs: 0, live: [{ who: owned[0].who, current: native }] });
    expect(clock.expiry).toBeInstanceOf(FormatterStatReadExpiry);
    expect((clock.expiry as Error).cause).toBe(clock.stat.failure);
    expect(((error as Error).cause as AggregateError).errors).toEqual([clock.expiry]);
    expect(clock.reads).toEqual([
      [1234, 300],
      [1234, 290],
    ]);
  });

  it('does not use a fixture identity when its first owned stat read expires', async () => {
    const clock = new OwnedStatExpirySettlementClock();
    clock.firstReadExpires = true;
    const error = await waitForFormatterSettlement(owned, clock).catch(
      (failure: unknown) => failure
    );
    expect((error as Error).message).toContain('received: no in-budget observation');
    expect(((error as Error).cause as AggregateError).errors).toEqual([clock.expiry]);
    expect(clock.reads).toEqual([[1234, 300]]);
  });

  it.each(['PID', 'budget'] as const)(
    'keeps a stat expiry for another %s as a query failure',
    async (mismatch) => {
      const clock = new OwnedStatExpirySettlementClock();
      clock.firstReadExpires = true;
      clock.wrongPid = mismatch === 'PID';
      clock.wrongBudget = mismatch === 'budget';
      const error = await waitForFormatterSettlement(owned, clock).catch(
        (failure: unknown) => failure
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toContain('native observation failed');
      expect((error as AggregateError).errors).toEqual([clock.expiry]);
    }
  );

  it('keeps a concurrent stat expiry and independent failure as a failed census', async () => {
    const clock = new MixedStatExpirySettlementClock();
    const second = { who: 'second controlled formatter', native: { ...native, pid: 5678 } };
    const error = await waitForFormatterSettlement([...owned, second], clock).catch(
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain('native observation failed');
    expect((error as AggregateError).errors).toEqual([clock.expiry, clock.independentFailure]);
    expect((error as AggregateError).cause).toBe(clock.expiry);
  });

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
  it.each([0, 7])(
    'does not admit another native read after a pause overruns by %s ms',
    async (overrun) => {
      const clock = new TimedNativeSettlementTranscript();
      clock.pauseOverrun = overrun;
      await expect(waitForFormatterSettlement(owned, clock)).rejects.toThrow(
        'expected live owned processes: 0 within 300ms'
      );
      expect(clock.admissions.length).toBeGreaterThan(0);
      expect(clock.admissions.every(({ at }) => at < 300)).toBe(true);
      expect(clock.time).toBeGreaterThanOrEqual(300);
    }
  );
  it.each(['absent', 'zombie', 'replaced birth'] as const)(
    'refuses a late %s observation as proof of in-budget settlement',
    async (mode) => {
      const clock = new TimedNativeSettlementTranscript();
      clock.readDuration = 301;
      clock.current.set(
        1234,
        mode === 'absent'
          ? undefined
          : {
              ...native,
              state: mode === 'zombie' ? 'Z' : 'S',
              identity: mode === 'replaced birth' ? '1234:new-birth' : native.identity,
            }
      );
      await expect(waitForFormatterSettlement(owned, clock)).rejects.toThrow(
        'expected native observation completion within 300ms'
      );
      expect(clock.admissions).toEqual([{ at: 0, budget: 300 }]);
    }
  );
  it('accepts native absence observed exactly at the deadline', async () => {
    const clock = new TimedNativeSettlementTranscript();
    clock.readDuration = 300;
    clock.current.set(1234, undefined);
    await waitForFormatterSettlement(owned, clock);
    expect(clock.time).toBe(300);
    expect(clock.admissions).toEqual([{ at: 0, budget: 300 }]);
  });
  it.each(['absent', 'zombie', 'replaced birth', 'live'] as const)(
    'discards late %s and retains only the previous in-budget live witness',
    async (mode) => {
      const lateResult =
        mode === 'absent'
          ? undefined
          : {
              ...native,
              state: mode === 'zombie' ? 'Z' : 'S',
              identity: mode === 'replaced birth' ? '1234:late-birth' : native.identity,
            };
      const clock = new LateNativeFulfillmentTranscript(lateResult);
      const error = await waitForFormatterSettlement(owned, clock).then(
        () => undefined,
        (failure: unknown) => failure
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('expected live owned processes: 0 within 300ms');
      const snapshot = JSON.parse(message.split('received last native observation: ')[1] ?? 'null');
      expect(snapshot).toEqual({
        elapsedMs: 0,
        live: [{ who: 'controlled formatter', current: native }],
      });
      expect(clock.reads).toEqual([
        [1234, 300],
        [1234, 290],
      ]);
      expect(clock.time).toBe(310);
    }
  );
  it('preserves a short final native query failure with its PID, budget and cause', async () => {
    const clock = new TimedNativeSettlementTranscript();
    clock.rejectFrom = 290;
    clock.failureDuration = 10;
    const error = await waitForFormatterSettlement(owned, clock).then(
      () => undefined,
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.errors).toEqual([clock.queryFailure]);
    expect(aggregate.cause).toBe(clock.queryFailure);
    expect(aggregate.message).toContain('native observation failed');
    expect(aggregate.message).toContain('1234');
    expect(aggregate.message).toContain('"budgetMs":10');
    expect(aggregate.message).toContain('"elapsedMs":300');
    expect(aggregate.message).toContain(clock.queryFailure.message);
    expect(aggregate.message).toContain(
      `"previousCompleteObservation":${JSON.stringify({ elapsedMs: 280, live: [{ who: owned[0].who, current: native }] })}`
    );
    expect(clock.admissions.at(-1)).toEqual({ at: 290, budget: 10 });
  });
  it('reports no previous complete census when the first native query fails', async () => {
    const clock = new TimedNativeSettlementTranscript();
    clock.rejectFrom = 0;
    const failure = await waitForFormatterSettlement(owned, clock).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toContain('"previousCompleteObservation":null');
    expect(aggregate.errors).toEqual([clock.queryFailure]);
    expect(aggregate.cause).toBe(clock.queryFailure);
    expect(clock.admissions).toEqual([{ at: 0, budget: 300 }]);
  });
  it('uses the fractional remainder without rounding up a new query budget', async () => {
    const clock = new TimedNativeSettlementTranscript();
    clock.pauseDurations.push(299.5);
    await expect(waitForFormatterSettlement(owned, clock)).rejects.toThrow(
      'expected live owned processes: 0 within 300ms'
    );
    expect(clock.admissions).toEqual([{ at: 0, budget: 300 }]);
    expect(clock.time).toBe(300);
  });
  it('preserves a late rejected query instead of substituting a prior live witness', async () => {
    const clock = new TimedNativeSettlementTranscript();
    clock.rejectFrom = 290;
    clock.failureDuration = 20;
    const error = await waitForFormatterSettlement(owned, clock).then(
      () => undefined,
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.errors).toHaveLength(1);
    expect(aggregate.errors[0]).toBe(clock.queryFailure);
    expect(aggregate.cause).toBe(clock.queryFailure);
    expect(aggregate.message).toContain('native observation failed');
    expect(aggregate.message).toContain('"elapsedMs":310');
  });
  it('does not report a live verdict when no native query fits before the deadline', async () => {
    const clock = new TimedNativeSettlementTranscript();
    clock.nowReadAdvance = 300;
    await expect(waitForFormatterSettlement(owned, clock)).rejects.toThrow(
      'expected native observation before the 300ms deadline'
    );
    expect(clock.admissions).toEqual([]);
  });
  it('retains every failed owned query and its original error', async () => {
    const clock = new TimedNativeSettlementTranscript();
    clock.rejectFrom = 0;
    const secondFailure = new TypeError('second controlled native observation refusal');
    clock.failuresByPid.set(5678, secondFailure);
    const second = { who: 'second formatter', native: { ...native, pid: 5678 } };
    const error = await waitForFormatterSettlement([...owned, second], clock).then(
      () => undefined,
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBe(clock.queryFailure);
    expect(aggregate.errors[1]).toBe(secondFailure);
    expect(aggregate.message).toContain('"pid":1234');
    expect(aggregate.message).toContain('"pid":5678');
    expect(clock.reads).toEqual([
      [1234, 300],
      [5678, 300],
    ]);
  });
  it('rejects the same previous complete witness after its owned query budget expires', async () => {
    const clock = new OwnedExpirySettlementClock();
    const error = await waitForFormatterSettlement(owned, clock).catch(
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('expected live owned processes: 0 within 300ms');
    const snapshot = JSON.parse(
      (error as Error).message.split('received last native observation: ')[1] ?? 'null'
    );
    expect(snapshot).toEqual({ elapsedMs: 0, live: [{ who: owned[0].who, current: native }] });
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(((error as Error).cause as AggregateError).errors).toEqual(clock.expiries);
    expect(clock.expiries[0]?.cause).toBe(clock.expiryReason);
    expect(clock.reads).toEqual([
      [1234, 300],
      [1234, 290],
    ]);
  });
  it('does not use the fixture initial identity when the first owned query expires', async () => {
    const clock = new OwnedExpirySettlementClock();
    clock.firstReadExpires = true;
    const error = await waitForFormatterSettlement(owned, clock).catch(
      (failure: unknown) => failure
    );
    expect((error as Error).message).toContain('received: no in-budget observation');
    expect((error as Error).message).not.toContain('received last native observation');
    expect(((error as Error).cause as AggregateError).errors).toEqual(clock.expiries);
    expect(clock.reads).toEqual([[1234, 300]]);
  });
  it('waits only the fractional remainder after an owned expiry without polling again', async () => {
    const clock = new OwnedExpirySettlementClock();
    clock.expiryDuration = 289.5;
    const error = await waitForFormatterSettlement(owned, clock).catch(
      (failure: unknown) => failure
    );
    expect((error as Error).message).toContain('expected live owned processes: 0 within 300ms');
    expect(clock.time).toBe(300);
    expect(clock.reads).toEqual([
      [1234, 300],
      [1234, 290],
    ]);
    expect(((error as Error).cause as AggregateError).errors).toEqual(clock.expiries);
  });
  it('captures a positive remaining wait once when native time crosses the deadline', async () => {
    const clock = new OwnedExpirySettlementClock();
    clock.expiryDuration = 289.5;
    clock.advanceOnExpiryNowCall = 2;
    const error = await waitForFormatterSettlement(owned, clock).catch(
      (failure: unknown) => failure
    );
    expect((error as Error).message).toContain('expected live owned processes: 0 within 300ms');
    expect(clock.pauseDurations).toEqual([10, 0.5]);
    expect(clock.pauseDurations.every((duration) => duration > 0)).toBe(true);
    expect(clock.reads).toEqual([
      [1234, 300],
      [1234, 290],
    ]);
    expect(((error as Error).cause as AggregateError).errors).toEqual(clock.expiries);
  });
  it.each(['PID', 'budget'] as const)(
    'keeps a typed expiry for another %s as a query failure',
    async (mismatch) => {
      const clock = new OwnedExpirySettlementClock();
      clock.firstReadExpires = true;
      clock.wrongPid = mismatch === 'PID';
      clock.wrongBudget = mismatch === 'budget';
      const error = await waitForFormatterSettlement(owned, clock).catch(
        (failure: unknown) => failure
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toContain('native observation failed');
      expect((error as AggregateError).errors).toEqual(clock.expiries);
      expect((error as AggregateError).cause).toBe(clock.expiries[0]);
    }
  );
  it('retains the original expiry and a failure waiting for the remaining deadline', async () => {
    const clock = new OwnedExpirySettlementClock();
    clock.expiryDuration = 289.5;
    clock.pauseFailure = new Error('controlled remaining deadline wait refusal');
    const error = await waitForFormatterSettlement(owned, clock).catch(
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([...clock.expiries, clock.pauseFailure]);
    expect((error as AggregateError).cause).toBe(clock.expiries[0]);
  });
  it('keeps mixed owned expiry and independent errors as a generic failed census', async () => {
    const clock = new MixedExpirySettlementClock();
    const second = { who: 'second controlled formatter', native: { ...native, pid: 5678 } };
    const error = await waitForFormatterSettlement([...owned, second], clock).catch(
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain('native observation failed');
    expect((error as AggregateError).errors).toEqual([clock.expiry, clock.independentFailure]);
    expect((error as AggregateError).cause).toBe(clock.expiry);
  });
  it('accepts an empty ownership set without making native queries', async () => {
    const clock = new TimedNativeSettlementTranscript();
    clock.rejectFrom = 0;
    await waitForFormatterSettlement([], clock);
    expect(clock.admissions).toEqual([]);
  });
});
