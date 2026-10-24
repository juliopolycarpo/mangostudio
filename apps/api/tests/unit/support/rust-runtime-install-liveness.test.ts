import { describe, expect, it } from 'bun:test';
import { waitForProcessExit } from '../../support/fixtures/managed-process';
import { type ProcessLivenessProbe, processGone } from '../../support/process-liveness';

/** A named zero-signal probe with an explicit sequence, rejecting accidental extra calls. */
class FakeProcessLivenessProbe {
  readonly calls: Array<{ pid: number; signal: 0 }> = [];
  constructor(private readonly observations: unknown[]) {}
  readonly probe: ProcessLivenessProbe = (pid, signal) => {
    this.calls.push({ pid, signal });
    if (this.observations.length === 0) throw new Error('Unexpected extra liveness observation');
    const observation = this.observations.shift();
    if (observation !== 'live') throw observation;
  };
}

function probeFailure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`named probe ${code}`), { code });
}

describe('installer processGone evidence', () => {
  it('keeps a live PID unqualified at the existing zero-length deadline', async () => {
    const fake = new FakeProcessLivenessProbe(['live']);
    expect(await processGone(4242, 0, fake.probe)).toBe(false);
    expect(fake.calls).toEqual([{ pid: 4242, signal: 0 }]);
  });

  it('accepts only an established missing-PID observation', async () => {
    const fake = new FakeProcessLivenessProbe([probeFailure('ESRCH')]);
    expect(await processGone(4242, 0, fake.probe)).toBe(true);
    expect(fake.calls).toEqual([{ pid: 4242, signal: 0 }]);
  });

  it('retains polling until a live PID is reported missing', async () => {
    const fake = new FakeProcessLivenessProbe(['live', probeFailure('ESRCH')]);
    expect(await processGone(4242, 1000, fake.probe)).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  it.each(['EPERM', 'EACCES', 'EINVAL', 'UNKNOWN'])(
    'rejects %s rather than certifying cleanup',
    async (code) => {
      const error = probeFailure(code);
      const fake = new FakeProcessLivenessProbe([error]);
      let received: unknown;
      try {
        await processGone(4242, 0, fake.probe);
      } catch (failure) {
        received = failure;
      }
      expect(fake.calls).toEqual([{ pid: 4242, signal: 0 }]);
      expect(received).toBeInstanceOf(Error);
      expect((received as Error).message).toBe(
        `process liveness pid 4242: expected a liveness observation or an Error carrying ESRCH | received: ${code}: named probe ${code}`
      );
      expect((received as Error).cause).toBe(error);
    }
  );

  it('retains unknown thrown values with PID context', async () => {
    const fake = new FakeProcessLivenessProbe(['opaque probe failure']);
    await expect(processGone(4242, 0, fake.probe)).rejects.toThrow(
      'process liveness pid 4242: expected a liveness observation or an Error carrying ESRCH | received: unknown code: opaque probe failure'
    );
  });

  it('rejects a plain object carrying ESRCH instead of certifying cleanup', async () => {
    const failure = { code: 'ESRCH' };
    const fake = new FakeProcessLivenessProbe([failure]);
    let received: unknown;
    try {
      await processGone(4242, 0, fake.probe);
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(Error);
    expect((received as Error).message).toBe(
      'process liveness pid 4242: expected a liveness observation or an Error carrying ESRCH | received: ESRCH: [object Object]'
    );
    expect((received as Error).cause).toBe(failure);
    expect(fake.calls).toEqual([{ pid: 4242, signal: 0 }]);
  });

  it('distinguishes a real live child from its reaped exit', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'await Bun.stdin.text();'], {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      expect(child.pid).toBeGreaterThan(0);
      expect(await processGone(child.pid, 0)).toBe(false);
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(await processGone(child.pid, 0)).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
  });
});

describe('library-owned process exit evidence', () => {
  it('accepts ESRCH for the MCP cleanup caller', async () => {
    const fake = new FakeProcessLivenessProbe([probeFailure('ESRCH')]);
    await expect(waitForProcessExit(4242, 1000, fake.probe)).resolves.toBeUndefined();
    expect(fake.calls).toEqual([{ pid: 4242, signal: 0 }]);
  });

  it('rejects a plain object carrying ESRCH instead of resolving library cleanup', async () => {
    const failure = { code: 'ESRCH' };
    const fake = new FakeProcessLivenessProbe([failure]);
    let received: unknown;
    try {
      await waitForProcessExit(4242, 1000, fake.probe);
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(Error);
    expect((received as Error).message).toBe(
      'process liveness pid 4242: expected a liveness observation or an Error carrying ESRCH | received: ESRCH: [object Object]'
    );
    expect((received as Error).cause).toBe(failure);
    expect(fake.calls).toEqual([{ pid: 4242, signal: 0 }]);
  });

  it.each(['EPERM', 'UNKNOWN'])(
    'rejects %s rather than resolving library cleanup',
    async (code) => {
      const fake = new FakeProcessLivenessProbe([probeFailure(code)]);
      await expect(waitForProcessExit(4242, 1000, fake.probe)).rejects.toThrow(
        `process liveness pid 4242: expected a liveness observation or an Error carrying ESRCH | received: ${code}: named probe ${code}`
      );
      expect(fake.calls).toEqual([{ pid: 4242, signal: 0 }]);
    }
  );

  it.each([
    ['string', 'opaque sibling failure'],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
  ] as const)('rejects a non-Error %s throw from the sibling probe', async (_kind, value) => {
    const fake = new FakeProcessLivenessProbe([value]);
    await expect(waitForProcessExit(4242, 1000, fake.probe)).rejects.toThrow(
      `process liveness pid 4242: expected a liveness observation or an Error carrying ESRCH | received: unknown code: ${String(value)}`
    );
  });

  it('preserves the existing deadline-before-probe order at timeout zero', async () => {
    const fake = new FakeProcessLivenessProbe([probeFailure('ESRCH')]);
    await expect(waitForProcessExit(4242, 0, fake.probe)).rejects.toThrow(
      'Process 4242 did not exit within 0ms.'
    );
    expect(fake.calls).toEqual([]);
  });

  it('polls a live PID until the sibling observes ESRCH', async () => {
    const fake = new FakeProcessLivenessProbe(['live', probeFailure('ESRCH')]);
    await expect(waitForProcessExit(4242, 1000, fake.probe)).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(2);
  });
});
