import { describe, expect, it } from 'bun:test';
import { raceAgainstAbort } from '../../../src/lib/abort-race';

class Cancelled extends Error {}

describe('raceAgainstAbort', () => {
  it('settles with the promise when the signal never fires', async () => {
    const controller = new AbortController();

    await expect(
      raceAgainstAbort(Promise.resolve('row'), controller.signal, () => new Cancelled())
    ).resolves.toBe('row');
  });

  it('rejects with the abort error the moment the signal fires', async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => undefined);

    const raced = raceAgainstAbort(never, controller.signal, () => new Cancelled());
    controller.abort();

    await expect(raced).rejects.toBeInstanceOf(Cancelled);
  });

  it('rejects at once for a signal that already aborted', async () => {
    const never = new Promise<string>(() => undefined);

    await expect(
      raceAgainstAbort(never, AbortSignal.abort(), () => new Cancelled())
    ).rejects.toBeInstanceOf(Cancelled);
  });

  it('absorbs the losing promise rejecting after the abort won', async () => {
    const controller = new AbortController();
    const late = Promise.withResolvers<string>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const raced = raceAgainstAbort(late.promise, controller.signal, () => new Cancelled());
      controller.abort();
      await expect(raced).rejects.toBeInstanceOf(Cancelled);
      late.reject(new Error('query failed after cancel'));
      await Bun.sleep(0);

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
