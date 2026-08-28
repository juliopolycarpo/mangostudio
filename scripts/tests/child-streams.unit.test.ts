import { describe, expect, test } from 'bun:test';

import { pumpStream, readFirstLine } from '../lib/child-streams';

const encoder = new TextEncoder();

/** A stream that emits `chunks` in order and then ends. */
function streamOf(...chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

/** A stream that emits `chunks` and then stays open forever. */
function hangingStreamOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
}

describe('scripts/lib/child-streams', () => {
  describe('pumpStream', () => {
    test('collects every chunk into one string', async () => {
      const pumped = pumpStream(streamOf('first ', 'second'));
      await pumped.done;
      expect(pumped.text()).toBe('first second');
    });

    test('exposes what arrived so far before the stream ends', async () => {
      const pumped = pumpStream(hangingStreamOf('booting\n'));
      // The pump runs on the microtask queue, so one tick is enough.
      await Bun.sleep(10);
      expect(pumped.text()).toBe('booting\n');
    });

    test('flushes a multi-byte character split across chunks', async () => {
      const bytes = encoder.encode('café');
      const pumped = pumpStream(streamOf(bytes.slice(0, 4), bytes.slice(4)));
      await pumped.done;
      expect(pumped.text()).toBe('café');
    });

    test('returns an empty string for a stream that never emits', async () => {
      const pumped = pumpStream(streamOf());
      await pumped.done;
      expect(pumped.text()).toBe('');
    });
  });

  describe('readFirstLine', () => {
    test('returns the first record without its newline', async () => {
      const result = await readFirstLine(streamOf('{"type":"hello"}\nrest\n'), 5_000);
      expect(result).toEqual({ kind: 'line', line: '{"type":"hello"}' });
    });

    test('joins a record split across chunks', async () => {
      const result = await readFirstLine(streamOf('{"type":', '"hello"}\n'), 5_000);
      expect(result).toEqual({ kind: 'line', line: '{"type":"hello"}' });
    });

    test('reports eof with the partial when the stream ends unterminated', async () => {
      const result = await readFirstLine(streamOf('{"type":"hel'), 5_000);
      expect(result).toEqual({ kind: 'eof', partial: '{"type":"hel' });
    });

    test('reports eof with an empty partial when the stream ends silently', async () => {
      const result = await readFirstLine(streamOf(), 5_000);
      expect(result).toEqual({ kind: 'eof', partial: '' });
    });

    test('reports timeout with the partial when the stream stays open', async () => {
      const result = await readFirstLine(hangingStreamOf('{"type":"hel'), 100);
      expect(result).toEqual({ kind: 'timeout', partial: '{"type":"hel' });
    });

    // eof and timeout are opposite problems — a child that died versus one that
    // is too slow — so they must never collapse into one verdict (issue #957).
    test('discriminates eof from timeout on otherwise identical output', async () => {
      const ended = await readFirstLine(streamOf('partial'), 5_000);
      const hung = await readFirstLine(hangingStreamOf('partial'), 100);
      expect(ended.kind).toBe('eof');
      expect(hung.kind).toBe('timeout');
    });

    test('returns as soon as the record arrives rather than waiting out the budget', async () => {
      const startedAt = Date.now();
      const result = await readFirstLine(streamOf('ready\n'), 30_000);
      expect(result.kind).toBe('line');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });
  });
});
