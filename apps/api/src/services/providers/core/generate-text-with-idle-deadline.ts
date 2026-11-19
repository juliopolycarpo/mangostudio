import { HUB_HANDLER_IDLE_TIMEOUT_SECONDS } from '../../../lib/hub-connection-limits';
import type { AIProvider, TextGenerationRequest, TextGenerationResult } from '../types';
import { GenerationDeadlineError, TEXT_GENERATION_TIMEOUT_MS } from './generation-deadline';

/**
 * How long before Bun's handler limit the hub gives up on its own. Bun resets
 * the connection of a handler that has sent nothing for
 * `HUB_HANDLER_IDLE_TIMEOUT_SECONDS`, while the work carries on; the hub has to
 * answer with its own error first.
 */
export const HANDLER_LIMIT_MARGIN_MS = 15_000;

/** The longest a reply may run in one request handler, derived from Bun's limit. */
export const LONG_TEXT_GENERATION_MAX_MS =
  HUB_HANDLER_IDLE_TIMEOUT_SECONDS * 1_000 - HANDLER_LIMIT_MARGIN_MS;

export interface IdleDeadlineOptions {
  /** Longest silence between two chunks, and before the first. {@link TEXT_GENERATION_TIMEOUT_MS} when omitted. */
  readonly idleTimeoutMs?: number;
  /** Hard cap on the whole reply. {@link LONG_TEXT_GENERATION_MAX_MS} when omitted. */
  readonly maxDurationMs?: number;
}

/**
 * Collects one reply from the provider's stream for a request handler that
 * answers in one response (`POST /api/respond`, a compaction).
 *
 * A whole-response deadline would cut a long reply that is still arriving, so
 * the budget is the silence instead: the idle timer restarts on every chunk
 * (thinking included), and a vendor that goes quiet for `idleTimeoutMs` ends
 * the call with {@link GenerationDeadlineError} even if its stream ignores its
 * signal. `maxDurationMs` still caps the whole reply under Bun's handler limit.
 * The caller's own abort rejects with its reason and aborts the vendor call.
 * A provider with no stream falls back to `generateText` under the hard cap.
 *
 * @example
 * const { text } = await generateTextWithIdleDeadline(provider, { ...request, signal });
 */
export async function generateTextWithIdleDeadline(
  provider: AIProvider,
  req: TextGenerationRequest,
  options: IdleDeadlineOptions = {}
): Promise<TextGenerationResult> {
  const idleTimeoutMs = options.idleTimeoutMs ?? TEXT_GENERATION_TIMEOUT_MS;
  const maxDurationMs = options.maxDurationMs ?? LONG_TEXT_GENERATION_MAX_MS;
  const call = `${provider.providerType} text generation`;

  if (!provider.generateTextStream) {
    return provider.generateText({ ...req, timeoutMs: req.timeoutMs ?? maxDurationMs });
  }
  req.signal?.throwIfAborted();

  const vendorAbort = new AbortController();
  const signal = req.signal
    ? AbortSignal.any([req.signal, vendorAbort.signal])
    : vendorAbort.signal;

  let rejectInterrupted: (reason: unknown) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  // Settled before anything awaits it when the stream ends first.
  interrupted.catch(() => {});

  const expire = (error: GenerationDeadlineError) => {
    vendorAbort.abort(error);
    rejectInterrupted(error);
  };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const restartIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => expire(new GenerationDeadlineError(`${call} (no output)`, idleTimeoutMs)),
      idleTimeoutMs
    );
  };
  const maxTimer = setTimeout(
    () => expire(new GenerationDeadlineError(call, maxDurationMs)),
    maxDurationMs
  );
  const onCallerAbort = () => rejectInterrupted(req.signal?.reason);
  req.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const stream = provider.generateTextStream({
    ...req,
    signal,
    timeoutMs: req.timeoutMs ?? maxDurationMs,
  });
  const iterator = stream[Symbol.asyncIterator]();
  let text = '';
  try {
    restartIdleTimer();
    for (;;) {
      const step = await Promise.race([iterator.next(), interrupted]);
      if (step.done) break;
      restartIdleTimer();
      const chunk = step.value;
      if (chunk.type === 'error') {
        throw new Error(chunk.content || `${call} failed.`);
      }
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
    }
    // Providers end a stream quietly on abort; a half reply is not a result.
    req.signal?.throwIfAborted();
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    req.signal?.removeEventListener('abort', onCallerAbort);
    // Not awaited: a vendor that went silent never settles `return()`.
    void Promise.resolve(iterator.return?.()).catch(() => {});
  }

  if (!text.trim()) {
    throw new Error(`No text returned from ${provider.providerType} model "${req.modelName}".`);
  }
  return { text };
}
