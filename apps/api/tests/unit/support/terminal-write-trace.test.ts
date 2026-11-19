import { describe, expect, it } from 'bun:test';

import { FakeTerminalRuntimeClient } from '../../support/mocks/fake-terminal-runtime-client';
import { RefusingTerminalWriteClient } from '../../support/mocks/refusing-terminal-write-client';
import { describeTerminalWrites, traceTerminalWrites } from '../../support/terminal-write-trace';

/** A clock that advances by `stepMs` per reading. */
function steppingClock(stepMs: number): () => number {
  let reading = 1_000;
  return () => {
    const current = reading;
    reading += stepMs;
    return current;
  };
}

describe('traceTerminalWrites', () => {
  it('records an answered write and still forwards it to the runtime', async () => {
    const runtime = new FakeTerminalRuntimeClient();
    const traced = traceTerminalWrites(runtime, steppingClock(25));

    await traced.client.terminal.write({
      sessionId: 'session-1',
      data: Buffer.from('hello\r\n').toString('base64'),
    });

    expect(runtime.calls.write).toHaveLength(1);
    expect(traced.writes).toEqual([
      { sentAtMs: 1_000, bytes: 7, outcome: 'ok', settledAfterMs: 25 },
    ]);
  });

  it('records a refused write with its message and rethrows it', async () => {
    const runtime = new FakeTerminalRuntimeClient();
    const traced = traceTerminalWrites(
      new RefusingTerminalWriteClient(runtime, 'UNAVAILABLE: shell consent unconfirmed'),
      steppingClock(10)
    );

    const failure = await traced.client.terminal
      .write({ sessionId: 'session-1', data: Buffer.from('x').toString('base64') })
      .catch((cause: unknown) => cause);

    expect((failure as Error).message).toBe('UNAVAILABLE: shell consent unconfirmed');
    expect(traced.writes).toEqual([
      {
        sentAtMs: 1_000,
        bytes: 1,
        outcome: 'rejected',
        settledAfterMs: 10,
        error: 'UNAVAILABLE: shell consent unconfirmed',
      },
    ]);
  });

  it('shows a write still waiting on the runtime as pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new FakeTerminalRuntimeClient({ gateFirstWrite: () => gate });
    const traced = traceTerminalWrites(runtime);

    const pending = traced.client.terminal.write({ sessionId: 's', data: 'AA==' });
    expect(traced.writes.map((write) => write.outcome)).toEqual(['pending']);
    expect(traced.writes[0]?.settledAfterMs).toBeNull();
    release();
    await pending;
    expect(traced.writes.map((write) => write.outcome)).toEqual(['ok']);
  });

  it('passes every other call and the manifest through unchanged', async () => {
    const runtime = new FakeTerminalRuntimeClient();
    const traced = traceTerminalWrites(runtime);

    await traced.client.terminal.ack({ sessionId: 's', bytes: 3 });

    expect(runtime.calls.ack).toEqual([{ sessionId: 's', bytes: 3 }]);
    expect(traced.client.manifest).toBe(runtime.manifest);
    expect(traced.writes).toEqual([]);
  });
});

describe('describeTerminalWrites', () => {
  it('says none for an empty trace and prints entries as JSON otherwise', () => {
    expect(describeTerminalWrites([])).toBe('writes=none');
    expect(
      describeTerminalWrites([{ sentAtMs: 5, bytes: 2, outcome: 'ok', settledAfterMs: 1 }])
    ).toBe('writes=[{"sentAtMs":5,"bytes":2,"outcome":"ok","settledAfterMs":1}]');
  });
});
