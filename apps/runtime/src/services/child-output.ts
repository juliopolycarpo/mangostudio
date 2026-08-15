/**
 * Bounded capture of a child process's stdout or stderr.
 *
 * Two bounds, and both matter. `maxBytes` keeps a chatty command from filling
 * the runtime's memory. `stopSignal` keeps a *terminated* command from holding
 * the call open: a descendant that outlives the child it was started from
 * inherits these pipes, so waiting for EOF after killing the child can wait
 * forever. Cancelling the reader instead bounds the call on every platform,
 * whether or not the tree kill reached the descendant.
 */

interface CappedRead {
  readonly text: string;
  /** Bytes were dropped because they exceeded `maxBytes`. */
  readonly truncated: boolean;
  /** The reader was cancelled by `stopSignal` before EOF. */
  readonly stopped: boolean;
}

/**
 * Reads a byte stream, retaining at most `maxBytes` worth of data.
 *
 * Continues draining the stream past the cap (discarding bytes) so the child
 * never blocks on a full pipe. `truncated` is the cap; `stopped` is a
 * cancelled reader. Callers that want "short of what was written" OR them.
 *
 * // Usage: await readStreamCapped(proc.stdout, 65_536, terminated.signal)
 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  stopSignal?: AbortSignal
): Promise<CappedRead> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let truncated = false;
  let stopped = false;

  // Cancelling is what releases a read that is already waiting: the stream
  // settles it as done instead of leaving it parked on a pipe some surviving
  // process still holds. Racing the read against the signal would work too, and
  // would attach a reaction to the same promise once per chunk.
  const onStop = () => {
    stopped = true;
    void reader.cancel().catch(() => undefined);
  };
  if (stopSignal?.aborted) onStop();
  else stopSignal?.addEventListener('abort', onStop, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        continue;
      }
      chunks.push(value.subarray(0, remaining));
      capturedBytes += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) truncated = true;
    }
  } finally {
    stopSignal?.removeEventListener('abort', onStop);
    // A cancelled reader has already let go of the stream; releasing the lock
    // is only for the reader that read it to the end.
    if (!stopped) reader.releaseLock();
  }

  return { text: decodeChunks(chunks, capturedBytes), truncated, stopped };
}

function decodeChunks(chunks: readonly Uint8Array[], totalBytes: number): string {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
