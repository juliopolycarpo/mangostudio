/**
 * Reading a Server-Sent Events body from a raw `fetch`.
 *
 * The frontend has no `EventSource` anywhere — every streaming route is a
 * `fetch` whose body is decoded by hand — so this is the one place that knows
 * the wire format: `data: ` frames separated by newlines, with a partial
 * trailing line carried into the next chunk.
 *
 * Payloads are yielded one array per `read()` rather than one at a time on
 * purpose: a chunk can carry hundreds of frames, and that boundary is where a
 * consumer can batch its React state update instead of paying a render per
 * line — `useInstallStream` flushes there; `useUpgradeStream` leans on React's
 * own automatic batching, since an install script's output is already capped.
 */

import { SSE_FRAME_MAX_CHARS } from '@mangostudio/shared/streaming';
import { DelimitedTextSplitter } from '@mangostudio/shared/utils/delimited-text-splitter';

const DATA_PREFIX = 'data: ';

/**
 * The `data:` payloads in each chunk of an SSE body, in arrival order. Frames
 * without the prefix (comments, the keepalive) are dropped, and so is a final
 * line the stream ended before terminating.
 *
 * A line longer than `SSE_FRAME_MAX_CHARS` rejects the generator, so the
 * consumer sees a failed stream. The cap sits far above the longest line the
 * hub writes here: an install log line is at most the run's 1 MiB capture
 * limit, and about six times that once JSON-escaped.
 * // Usage: for await (const payloads of readSseChunks(reader)) …
 */
export async function* readSseChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<string[]> {
  const decoder = new TextDecoder();
  const lines = new DelimitedTextSplitter('\n', {
    maxRecordLength: SSE_FRAME_MAX_CHARS,
    onOverflow: 'refuse',
  });

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    // The splitter holds whatever came after the final newline, an incomplete
    // frame that has to wait for the next chunk.
    const payloads: string[] = [];
    for (const line of lines.push(decoder.decode(value, { stream: true }))) {
      if (line.startsWith(DATA_PREFIX)) payloads.push(line.slice(DATA_PREFIX.length));
    }
    yield payloads;
  }
}
