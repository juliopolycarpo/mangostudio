import { describe, expect, it } from 'bun:test';
import { readSseChunks } from '@/lib/sse';

function readerOf(chunks: readonly string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }).getReader();
}

async function collect(chunks: readonly string[]): Promise<string[][]> {
  const seen: string[][] = [];
  for await (const payloads of readSseChunks(readerOf(chunks))) seen.push(payloads);
  return seen;
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
});
