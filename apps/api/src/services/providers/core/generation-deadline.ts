/**
 * Hub-side deadlines for a provider's text generation.
 *
 * Bun's handler limit ends a slow request after 255 s, and the provider SDKs
 * default to minutes, so a vendor that accepts the connection and never answers
 * would hold a request that long. Each call site picks the budget that fits it:
 * a short one for a title, a commit message or a library suggestion, and an idle
 * deadline for a reply that may legitimately run for minutes
 * (`generateTextWithIdleDeadline`).
 */

/**
 * The whole-response deadline of `generateText` when the request names none,
 * and the longest silence `generateTextWithIdleDeadline` tolerates. It also
 * bounds the DeepSeek stream.
 */
export const TEXT_GENERATION_TIMEOUT_MS = 120_000;

/**
 * The whole-response budget for a short generation: a chat title, a commit
 * message, a library suggestion. They cap their output at a few hundred tokens,
 * so a minute without an answer means the vendor is stuck, not slow.
 */
export const SHORT_TEXT_GENERATION_TIMEOUT_MS = 60_000;

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
