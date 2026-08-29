// Stream helpers for smoke scripts that drive a spawned child process.
//
// Deliberately hand-rolled rather than reusing richer helpers from the app
// workspaces: `scripts/test-build.ts` runs in the smoke matrix under
// `--no-install`, so everything reachable from it must import nothing but
// `node:`/`bun` builtins. `scripts/tests/smoke-dependencies.unit.test.ts`
// enforces that by walking the transitive import graph.

/** A stream being drained in the background by {@link pumpStream}. */
export interface PumpedStream {
  /** Resolves once the stream ends. */
  readonly done: Promise<void>;
  /** Everything decoded so far; safe to call before `done` settles. */
  text(): string;
}

/**
 * Drains `stream` into a string without blocking the caller.
 *
 * A piped stream nobody reads is a full pipe and a lost diagnostic, so every
 * smoke that pipes `stderr` should hand it to this immediately after spawn.
 *
 * @example
 * const stderr = pumpStream(child.stderr);
 * await child.exited;
 * await stderr.done;
 * console.error(stderr.text());
 */
export function pumpStream(stream: ReadableStream<Uint8Array>): PumpedStream {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  const done = (async () => {
    while (true) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  })();

  return { done, text: () => text };
}

/** How {@link readFirstLine} stopped reading. */
export type FirstLineResult =
  /** A newline-terminated record arrived; `line` excludes the newline. */
  | { readonly kind: 'line'; readonly line: string }
  /** The deadline passed with the stream still open. */
  | { readonly kind: 'timeout'; readonly partial: string }
  /** The stream ended before any newline arrived. */
  | { readonly kind: 'eof'; readonly partial: string };

/**
 * Reads one newline-terminated record, or reports which way it failed.
 *
 * The two failure kinds are opposite problems — a child too slow to answer
 * versus a child that died or closed the pipe — so they are reported
 * separately, and whatever was buffered comes back with them.
 *
 * @example
 * const result = await readFirstLine(child.stdout, 10_000);
 * if (result.kind !== 'line') console.error(`no frame: ${result.kind}`);
 */
export async function readFirstLine(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number
): Promise<FirstLineResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A pending `Bun.sleep` would keep the loop alive for the rest of the budget
  // after a fast success; a cleared timer does not.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  let buffered = '';

  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (!chunk) return { kind: 'timeout', partial: buffered + decoder.decode() };
      if (chunk.done) return { kind: 'eof', partial: buffered + decoder.decode() };
      buffered += decoder.decode(chunk.value, { stream: true });
      const newline = buffered.indexOf('\n');
      if (newline !== -1) return { kind: 'line', line: buffered.slice(0, newline) };
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
