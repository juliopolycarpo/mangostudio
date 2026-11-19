/**
 * Named fake for a vendor that answers a long reply slowly: the stream yields a
 * chunk every `chunkIntervalMs`, and `generateText` behaves like the real
 * non-streaming providers, which hold the connection silent for the whole reply
 * under a whole-response deadline (`req.timeoutMs`, else the shared default).
 *
 * Time is whatever the test's timers say, so a suite on Bun's fake timers can
 * run a reply that "takes" minutes in milliseconds.
 */

import {
  TEXT_GENERATION_TIMEOUT_MS,
  withGenerationDeadline,
} from '../../../src/services/providers/core/generation-deadline';
import type {
  AIProvider,
  StreamingChunk,
  TextGenerationRequest,
} from '../../../src/services/providers/types';

export interface FakeLongTextProviderOptions {
  /** The reply, one text chunk each. */
  readonly chunks: readonly string[];
  /** Silence before every chunk. */
  readonly chunkIntervalMs: number;
  /** After this many chunks the vendor goes silent for good and ignores its signal. */
  readonly stallAfterChunks?: number;
}

export interface FakeLongTextProvider {
  readonly provider: AIProvider;
  /** Every `generateText` request, in call order. */
  readonly generateTextRequests: TextGenerationRequest[];
  /** Every `generateTextStream` request, in call order. */
  readonly generateTextStreamRequests: TextGenerationRequest[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFakeLongTextProvider(
  options: FakeLongTextProviderOptions
): FakeLongTextProvider {
  const generateTextRequests: TextGenerationRequest[] = [];
  const generateTextStreamRequests: TextGenerationRequest[] = [];
  const replyDurationMs = options.chunks.length * options.chunkIntervalMs;

  async function* streamReply(req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    for (const [index, text] of options.chunks.entries()) {
      if (options.stallAfterChunks !== undefined && index >= options.stallAfterChunks) {
        await new Promise<never>(() => {});
      }
      await sleep(options.chunkIntervalMs);
      // Real streaming providers end quietly when the caller aborts.
      if (req.signal?.aborted) break;
      yield { type: 'text', text, done: false };
    }
    yield { type: 'text', text: '', done: true };
  }

  const provider: AIProvider = {
    providerType: 'openai-compatible',
    warmup: () => Promise.resolve(),
    generateText: (req) => {
      generateTextRequests.push(req);
      return withGenerationDeadline(
        'Fake generateText',
        req.signal,
        req.timeoutMs ?? TEXT_GENERATION_TIMEOUT_MS,
        async () => {
          await sleep(replyDurationMs);
          return { text: options.chunks.join('') };
        }
      );
    },
    generateTextStream: (req) => {
      generateTextStreamRequests.push(req);
      return streamReply(req);
    },
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('test-key'),
  };

  return { provider, generateTextRequests, generateTextStreamRequests };
}
