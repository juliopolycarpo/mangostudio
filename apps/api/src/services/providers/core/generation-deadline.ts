/**
 * Hub-side deadline for a provider's non-streaming `generateText`.
 *
 * Bun's handler limit ends a slow request after 255 s, and the provider SDKs
 * default to minutes, so a vendor that accepts the connection and never answers
 * would hold a respond, a title, a compaction or a commit message that long.
 * The same 120 s bounds the DeepSeek stream, whose deadline this one matches.
 */
export const TEXT_GENERATION_TIMEOUT_MS = 120_000;

/** `call` ran past its deadline without the caller aborting it. */
export class GenerationDeadlineError extends Error {
  readonly call: string;
  readonly timeoutMs: number;

  constructor(call: string, timeoutMs: number, options?: ErrorOptions) {
    super(`${call} exceeded the ${timeoutMs} ms deadline.`, options);
    this.name = 'GenerationDeadlineError';
    this.call = call;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Runs `run` with a signal that aborts at `timeoutMs` or when `callerSignal`
 * does, and rejects with {@link GenerationDeadlineError} at the deadline even
 * if `run` ignores its signal. A caller's own abort passes through unchanged.
 *
 * @example
 * const text = await withGenerationDeadline('OpenAI generateText', req.signal, 120_000, (signal) =>
 *   client.chat.completions.create(body, { signal })
 * );
 */
export async function withGenerationDeadline<T>(
  call: string,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
  const expired = new Promise<never>((_resolve, reject) => {
    deadline.signal.addEventListener(
      'abort',
      () => reject(new GenerationDeadlineError(call, timeoutMs)),
      { once: true }
    );
  });

  try {
    return await Promise.race([run(signal), expired]);
  } catch (error) {
    // The SDK may reject with its own abort error before `expired` settles.
    if (
      deadline.signal.aborted &&
      !callerSignal?.aborted &&
      !(error instanceof GenerationDeadlineError)
    ) {
      throw new GenerationDeadlineError(call, timeoutMs, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
