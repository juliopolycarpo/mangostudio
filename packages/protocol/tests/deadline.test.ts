import { describe, expect, it } from 'bun:test';
import { abortReason, connectDeadline } from '../src/transports/deadline';

/** Resolves after `ms`, so a test can watch a deadline pass or fail to. */
function after(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('connectDeadline', () => {
  it('aborts with a TimeoutError naming the target and the budget', async () => {
    const deadline = connectDeadline('/run/mango.sock', { timeoutMs: 10 });

    await after(30);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toMatchObject({
      name: 'TimeoutError',
      message:
        'The connection to /run/mango.sock timed out after 10 ms; expected the peer to accept it.',
    });
  });

  it('never aborts once it has been disposed', async () => {
    const deadline = connectDeadline('/run/mango.sock', { timeoutMs: 10 });

    deadline.dispose();
    await after(30);

    expect(deadline.signal.aborted).toBe(false);
  });

  it('forwards the caller signal with the reason it carried', () => {
    const controller = new AbortController();
    const deadline = connectDeadline('/run/mango.sock', { signal: controller.signal });

    controller.abort(new Error('the caller gave up'));

    expect(deadline.signal.reason).toMatchObject({ message: 'the caller gave up' });
  });

  it('is already aborted when the caller signal was', () => {
    const deadline = connectDeadline('/run/mango.sock', {
      signal: AbortSignal.abort(new Error('gone before we dialled')),
      timeoutMs: 10,
    });

    expect(deadline.signal.aborted).toBe(true);
    expect(abortReason('/run/mango.sock', deadline.signal).message).toBe('gone before we dialled');
  });

  it('stops forwarding a caller signal that aborts after the dial settled', () => {
    const controller = new AbortController();
    const deadline = connectDeadline('/run/mango.sock', { signal: controller.signal });

    deadline.dispose();
    controller.abort();

    expect(deadline.signal.aborted).toBe(false);
  });

  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`refuses the deadline ${String(timeoutMs)}`, () => {
      expect(() => connectDeadline('/run/mango.sock', { timeoutMs })).toThrow(
        `timeoutMs is ${String(timeoutMs)}; expected a positive finite number of milliseconds, or none for no deadline`
      );
    });
  }
});

describe('abortReason', () => {
  it('names an abort whose reason is not an error', () => {
    const controller = new AbortController();
    controller.abort('a string reason');

    expect(abortReason('/run/mango.sock', controller.signal)).toMatchObject({
      name: 'AbortError',
      message: 'The connection to /run/mango.sock was aborted.',
    });
  });
});
