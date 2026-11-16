import { describe, expect, it, spyOn } from 'bun:test';

import { SSE_FRAME_MAX_CHARS } from '@mangostudio/shared/streaming';
import { DelimitedTextSplitter } from '@mangostudio/shared/utils/delimited-text-splitter';

import { readSseChunks, SseFrameTooLongError } from '@/lib/sse';

function readerOfBytes(chunks: readonly Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }).getReader();
}

function readerOf(chunks: readonly string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  return readerOfBytes(chunks.map((chunk) => encoder.encode(chunk)));
}

async function collectFrom(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string[][]> {
  const seen: string[][] = [];
  for await (const payloads of readSseChunks(reader)) seen.push(payloads);
  return seen;
}

async function collect(chunks: readonly string[]): Promise<string[][]> {
  return collectFrom(readerOf(chunks));
}

/**
 * What a whole-stream reader reports: decode everything at once, split at every
 * `\n`, drop the unterminated last piece, keep the `data: ` payloads.
 */
function payloadsOfWholeStream(bytes: Uint8Array): string[] {
  const lines = new TextDecoder().decode(bytes).split('\n');
  lines.pop();
  return lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
}

function cutAt(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  let start = 0;
  for (const offset of [...offsets, bytes.byteLength]) {
    pieces.push(bytes.slice(start, offset));
    start = offset;
  }
  return pieces;
}

describe('readSseChunks', () => {
  it('yields one array per read, so a consumer can batch its state update there', async () => {
    expect(await collect(['data: a\n\ndata: b\n\n', 'data: c\n\n'])).toEqual([['a', 'b'], ['c']]);
  });

  it('carries a frame split across two chunks into the next one', async () => {
    // A `read()` boundary lands wherever the socket happens to flush; a frame
    // cut in half must not be delivered as two broken payloads.
    expect(await collect(['data: {"ty', 'pe":"stage"}\n\n'])).toEqual([[], ['{"type":"stage"}']]);
  });

  it('drops the keepalive comment and anything else without the data prefix', async () => {
    expect(await collect([': keepalive\n\ndata: a\n\n'])).toEqual([['a']]);
  });

  it('never yields a frame the stream ended in the middle of', async () => {
    expect(await collect(['data: a\n\ndata: unterminated'])).toEqual([['a']]);
  });

  it('keeps a CR before the newline in the payload, as the whole-stream split does', async () => {
    expect(await collect(['data: a\r\n', 'data: b\r\n'])).toEqual([['a\r'], ['b\r']]);
  });

  describe('against splitting the whole stream', () => {
    // Multi-byte characters (2, 3 and 4 bytes) so that a cut can land inside one.
    const stream = new TextEncoder().encode(
      'data: café\n\n: keepalive\n\ndata: ✓ ok\n\ndata: \u{1f96d}\n\nevent: x\ndata: {"a":"\u{1f96d}"}\n\ndata: dropped, no newline'
    );
    const expectedPayloads = payloadsOfWholeStream(stream);

    it('has the payloads the cases below depend on', () => {
      expect(expectedPayloads).toEqual(['café', '✓ ok', '\u{1f96d}', '{"a":"\u{1f96d}"}']);
    });

    it('yields the same payloads when the stream is cut in two at every byte', async () => {
      for (let cut = 0; cut <= stream.byteLength; cut += 1) {
        const seen = await collectFrom(readerOfBytes(cutAt(stream, [cut])));

        expect({ cut, payloads: seen.flat() }).toEqual({ cut, payloads: expectedPayloads });
      }
    });

    it('yields the same payloads when every read is one byte, so any UTF-8 sequence is split', async () => {
      const seen = await collectFrom(
        readerOfBytes(
          cutAt(
            stream,
            Array.from({ length: stream.byteLength - 1 }, (_, i) => i + 1)
          )
        )
      );

      expect(seen.flat()).toEqual(expectedPayloads);
      expect(seen).toHaveLength(stream.byteLength);
    });

    it('yields the same payloads for random chunkings', async () => {
      // A small deterministic generator: a failure names the seed to replay.
      for (let seed = 1; seed <= 200; seed += 1) {
        let state = seed;
        const next = (): number => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return state;
        };
        const offsets: number[] = [];
        for (let at = 1 + (next() % 9); at < stream.byteLength; at += 1 + (next() % 9)) {
          offsets.push(at);
        }

        const seen = await collectFrom(readerOfBytes(cutAt(stream, offsets)));

        expect({ seed, payloads: seen.flat() }).toEqual({ seed, payloads: expectedPayloads });
      }
    });
  });

  describe('line cap', () => {
    async function rejectionOf(chunks: readonly string[]): Promise<{
      readonly error: unknown;
      readonly seen: string[][];
    }> {
      const seen: string[][] = [];
      try {
        for await (const payloads of readSseChunks(readerOf(chunks))) seen.push(payloads);
      } catch (error) {
        return { error, seen };
      }
      throw new Error(`expected readSseChunks to reject | received: ${JSON.stringify(seen)}`);
    }

    it(`rejects with a SseFrameTooLongError carrying the length and the cap when one line outgrows ${SSE_FRAME_MAX_CHARS} characters`, async () => {
      const { error, seen } = await rejectionOf([
        'data: ok\n',
        `data: ${'a'.repeat(SSE_FRAME_MAX_CHARS)}`,
      ]);

      expect(error).toBeInstanceOf(SseFrameTooLongError);
      expect(error).toMatchObject({
        name: 'SseFrameTooLongError',
        lineLength: SSE_FRAME_MAX_CHARS + 6,
        maxLineLength: SSE_FRAME_MAX_CHARS,
        message: `SSE line of ${SSE_FRAME_MAX_CHARS + 6} characters exceeds the ${SSE_FRAME_MAX_CHARS}-character limit`,
      });
      expect(seen).toEqual([['ok']]);
    });

    it('delivers the payloads the same read completed before the oversized line, then rejects', async () => {
      const { error, seen } = await rejectionOf([
        `data: one\ndata: two\ndata: ${'a'.repeat(SSE_FRAME_MAX_CHARS)}`,
        'data: never read\n',
      ]);

      expect(error).toBeInstanceOf(SseFrameTooLongError);
      expect(seen).toEqual([['one', 'two']]);
    });

    it('still rejects when the body ends right after the read that held the oversized line', async () => {
      const { error, seen } = await rejectionOf([
        `data: one\ndata: ${'a'.repeat(SSE_FRAME_MAX_CHARS)}`,
      ]);

      expect(error).toBeInstanceOf(SseFrameTooLongError);
      expect(seen).toEqual([['one']]);
    });

    it('accepts a line of exactly the cap', async () => {
      const payload = 'a'.repeat(SSE_FRAME_MAX_CHARS - 'data: '.length);

      const seen = await collect([`data: ${payload}`, '\n']);

      expect(seen.map((payloads) => payloads.map((item) => item.length))).toEqual([
        [],
        [payload.length],
      ]);
    });
  });

  // The reader used to append each read to one string and split it again, so a
  // line spanning n reads cost O(line * n): 1 MiB in 16-byte reads took several
  // seconds. Rather than time it, pin that every read goes through the splitter
  // once and only the new text is handed to it: the splitter's own linearity is
  // proven in apps/shared/tests/unit/delimited-text-splitter.test.ts.
  it('hands each read to the splitter once, and nothing else, for a 1 MiB line in 16-byte reads', async () => {
    const bytes = new TextEncoder().encode(`data: ${'a'.repeat(1024 * 1024)}\n`);
    const reads: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 16) {
      reads.push(bytes.slice(offset, offset + 16));
    }
    const push = spyOn(DelimitedTextSplitter.prototype, 'push');
    try {
      const seen = await collectFrom(readerOfBytes(reads));

      expect(seen.flat().map((payload) => payload.length)).toEqual([1024 * 1024]);
      expect({
        calls: push.mock.calls.length,
        charactersHandedIn: push.mock.calls.reduce((total, [text]) => total + text.length, 0),
      }).toEqual({ calls: reads.length, charactersHandedIn: bytes.byteLength });
    } finally {
      push.mockRestore();
    }
  });
});
