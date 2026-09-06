import { describe, expect, it } from 'bun:test';
import { sseResponse } from '../../../src/lib/sse-stream';

async function readEvents(response: Response): Promise<unknown[]> {
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

async function* asyncIterableFrom<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

describe('sseResponse', () => {
  it('sends the right headers and every event as its own data: line', async () => {
    const response = sseResponse(asyncIterableFrom([{ type: 'a' }, { type: 'b' }]), 'boom');

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(await readEvents(response)).toEqual([{ type: 'a' }, { type: 'b' }]);
  });

  it('turns a thrown Error into one error event carrying its message', async () => {
    // biome-ignore lint/correctness/useYield: this generator only ever throws.
    async function* failing(): AsyncGenerator<{ type: string }> {
      await Promise.resolve();
      throw new Error('the source blew up');
    }

    const events = await readEvents(sseResponse(failing(), 'fallback'));

    expect(events).toEqual([
      { type: 'error', error: 'the source blew up', code: 'INTERNAL', done: true },
    ]);
  });

  it('falls back to the given message for a non-Error rejection', async () => {
    // A hand-built iterator, not `throw`, so this exercises a rejection that
    // is not an Error instance without tripping the no-throw-non-Error lint.
    const failing: AsyncIterable<{ type: string }> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject('not an Error instance'),
      }),
    };

    const events = await readEvents(sseResponse(failing, 'fallback message'));

    expect(events).toEqual([
      { type: 'error', error: 'fallback message', code: 'INTERNAL', done: true },
    ]);
  });

  it('returns the source iterator when the stream is cancelled', async () => {
    let returned = false;
    const source: AsyncIterable<{ type: string }> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => undefined as never), // never resolves
          return: () => {
            returned = true;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };

    const response = sseResponse(source, 'boom');
    // Reading the body and immediately cancelling races the never-resolving
    // next() against cancel(); getReader().cancel() is what the ReadableStream
    // spec routes to the underlying source's cancel() callback.
    const reader = response.body?.getReader();
    await reader?.cancel();

    expect(returned).toBe(true);
  });
});
