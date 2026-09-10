import { describe, expect, it } from 'bun:test';
import { rejectionOf } from '@mangostudio/protocol/testing';
import { dialDeadline } from '../../../../src/services/runtime-client/dial-deadline';

/** A dial that never settles on its own, so only the deadline can end it. */
function neverSettles(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

describe('dialDeadline', () => {
  it('aborts with the message it was given once the deadline passes', async () => {
    const deadline = dialDeadline(5, 'The runtime did not answer at ws://127.0.0.1:1/.');

    const error = await rejectionOf(neverSettles(deadline.signal));

    expect(deadline.signal.aborted).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('The runtime did not answer at ws://127.0.0.1:1/.');
  });

  it('never fires once it is cleared', async () => {
    const deadline = dialDeadline(1, 'should not fire');
    deadline.clear();

    await Bun.sleep(10);

    expect(deadline.signal.aborted).toBe(false);
  });

  it('tolerates a clear after it already fired', async () => {
    const deadline = dialDeadline(1, 'already fired');

    await Bun.sleep(10);
    deadline.clear();

    expect(deadline.signal.aborted).toBe(true);
  });
});
