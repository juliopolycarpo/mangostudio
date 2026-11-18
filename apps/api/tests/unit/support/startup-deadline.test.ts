import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@mangostudio/protocol/testing';

import { startupDeadline } from '../../support/startup-deadline';

/** A wait that never settles on its own, so only the deadline can end it. */
function neverSettles(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

describe('startupDeadline', () => {
  it('aborts with the message it was given once the deadline passes', async () => {
    const deadline = startupDeadline(5, 'Serve health deadline exceeded 5ms');

    const error = await rejectionOf(neverSettles(deadline.signal));

    expect(deadline.signal.aborted).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Serve health deadline exceeded 5ms');
  });

  it('never fires once it is cleared', async () => {
    const deadline = startupDeadline(1, 'should not fire');
    deadline.clear();

    await Bun.sleep(10);

    expect(deadline.signal.aborted).toBe(false);
  });

  it('tolerates a clear after it already fired', async () => {
    const deadline = startupDeadline(1, 'already fired');

    await Bun.sleep(10);
    deadline.clear();

    expect(deadline.signal.aborted).toBe(true);
  });
});
