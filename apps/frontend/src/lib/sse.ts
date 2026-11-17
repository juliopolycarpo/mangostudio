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
import {
  DelimitedTextSplitter,
  RecordTooLongError,
} from '@mangostudio/shared/utils/delimited-text-splitter';

const DATA_PREFIX = 'data: ';

/**
 * A line of the body outgrew `SSE_FRAME_MAX_CHARS`. Consumers match on this, not
 * on `RangeError`, to tell a body the cap refused from any other failure.
 */
export class SseFrameTooLongError extends Error {
  /** Characters of the line seen when it was refused; a lower bound when it never ended. */
  readonly lineLength: number;
  readonly maxLineLength: number;

  constructor(lineLength: number, maxLineLength: number, options?: ErrorOptions) {
    super(
      `SSE line of ${lineLength} characters exceeds the ${maxLineLength}-character limit`,
      options
    );
    this.name = 'SseFrameTooLongError';
    this.lineLength = lineLength;
    this.maxLineLength = maxLineLength;
  }
}

/**
 * The `data:` payloads in each chunk of an SSE body, in arrival order. Frames
 * without the prefix (comments, the keepalive) are dropped, and so is a final
 * line the stream ended before terminating.
 *
 * A line longer than `SSE_FRAME_MAX_CHARS` rejects the generator with a
 * {@link SseFrameTooLongError}, after the payloads the same read completed
 * before it. The cap sits far above the longest line the hub writes on the
 * streams read here: an install log line is at most the run's 1 MiB capture
 * limit and about six times that once JSON-escaped, and the runtime lifecycle
 * stream's largest source is container pull output at 4 MiB, about 24 MiB
 * escaped.
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

  try {
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
    // A refusal that came with the last read's payloads is raised here, so a
    // body that ends right after an oversized line still fails. The unterminated
    // line `finish` returns is dropped, as it always was.
    lines.finish();
  } catch (error) {
    if (error instanceof RecordTooLongError) {
      throw new SseFrameTooLongError(error.recordLength, error.maxRecordLength, { cause: error });
    }
    throw error;
  }
}
