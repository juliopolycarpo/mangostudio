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

const DATA_PREFIX = 'data: ';

/**
 * The `data:` payloads in each chunk of an SSE body, in arrival order. Frames
 * without the prefix (comments, the keepalive) are dropped.
 * // Usage: for await (const payloads of readSseChunks(reader)) …
 */
export async function* readSseChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<string[]> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    // The last element is whatever came after the final newline — an
    // incomplete frame that has to wait for the next chunk.
    buffer = parts.pop() ?? '';

    const payloads: string[] = [];
    for (const part of parts) {
      if (part.startsWith(DATA_PREFIX)) payloads.push(part.slice(DATA_PREFIX.length));
    }
    yield payloads;
  }
}
