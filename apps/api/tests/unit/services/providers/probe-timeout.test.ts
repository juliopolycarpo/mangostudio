import { describe, expect, it } from 'bun:test';
import {
  withAbortTimeout,
  withPromiseTimeout,
} from '../../../../src/services/providers/core/probe-timeout';

describe('provider probe timeout helpers', () => {
  it('returns the loader result before the timeout elapses', async () => {
    const result = await withAbortTimeout(() => Promise.resolve('ok'), 'probe timed out', 10);

    expect(result).toBe('ok');
  });

  it('rejects slow abort-aware probes with the timeout message', async () => {
    const result = withAbortTimeout(
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted upstream request')), {
            once: true,
          });
        }),
      'probe timed out',
      1
    );

    try {
      await result;
      throw new Error('Expected probe timeout rejection.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('probe timed out');
    }
  });

  it('rejects slow promise-based probes with the timeout message', async () => {
    const result = withPromiseTimeout(
      () => new Promise<string>(() => undefined),
      'catalog timed out',
      1
    );

    try {
      await result;
      throw new Error('Expected catalog timeout rejection.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('catalog timed out');
    }
  });
});
