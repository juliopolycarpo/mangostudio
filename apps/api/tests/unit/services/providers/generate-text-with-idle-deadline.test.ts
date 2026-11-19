import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import { HUB_HANDLER_IDLE_TIMEOUT_SECONDS } from '../../../../src/lib/hub-connection-limits';
import {
  generateTextWithIdleDeadline,
  HANDLER_LIMIT_MARGIN_MS,
  LONG_TEXT_GENERATION_MAX_MS,
} from '../../../../src/services/providers/core/generate-text-with-idle-deadline';
import {
  GenerationDeadlineError,
  TEXT_GENERATION_TIMEOUT_MS,
} from '../../../../src/services/providers/core/generation-deadline';
import type {
  AIProvider,
  StreamingChunk,
  TextGenerationRequest,
} from '../../../../src/services/providers/types';
import { advanceFakeClock } from '../../../support/fake-clock';
import { createFakeLongTextProvider } from '../../../support/providers/fake-long-text-provider';

const baseReq: TextGenerationRequest = {
  userId: 'test-user',
  history: [],
  prompt: 'Summarize',
  modelName: 'test-model',
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

type Outcome =
  | { readonly status: 'resolved'; readonly text: string }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'pending' };

/** Starts `call`, advances the fake clock by `totalMs` in 1 s steps and reports where it stands. */
async function settleAfter(call: Promise<{ text: string }>, totalMs: number): Promise<Outcome> {
  let outcome: Outcome = { status: 'pending' };
  call.then(
    (result) => (outcome = { status: 'resolved', text: result.text }),
    (error: unknown) => (outcome = { status: 'rejected', error })
  );
  for (let elapsed = 0; elapsed < totalMs && outcome.status === 'pending'; elapsed += 1_000) {
    await advanceFakeClock(1_000);
  }
  return outcome;
}

function describeOutcome(outcome: Outcome): string {
  if (outcome.status !== 'rejected') return outcome.status;
  return outcome.error instanceof Error
    ? `${outcome.error.name}: ${outcome.error.message}`
    : String(outcome.error);
}

/** A provider whose stream yields exactly `chunks`, then ends. */
function createScriptedStreamProvider(chunks: readonly StreamingChunk[]): AIProvider {
  return {
    providerType: 'openai-compatible',
    generateText: () => Promise.reject(new Error('generateText must not run when a stream exists')),
    generateTextStream: () => ({
      [Symbol.asyncIterator]: () => {
        const remaining = [...chunks];
        return {
          next: (): Promise<IteratorResult<StreamingChunk>> => {
            const value = remaining.shift();
            return Promise.resolve(
              value ? { done: false, value } : { done: true, value: undefined }
            );
          },
        };
      },
    }),
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('test-key'),
  };
}

describe('generateTextWithIdleDeadline', () => {
  it('derives the hard cap from the Bun handler limit minus a margin', () => {
    expect(LONG_TEXT_GENERATION_MAX_MS).toBe(
      HUB_HANDLER_IDLE_TIMEOUT_SECONDS * 1_000 - HANDLER_LIMIT_MARGIN_MS
    );
    expect(LONG_TEXT_GENERATION_MAX_MS).toBeLessThan(HUB_HANDLER_IDLE_TIMEOUT_SECONDS * 1_000);
  });

  it('survives a reply that keeps arriving past the idle deadline', async () => {
    const fake = createFakeLongTextProvider({
      chunks: Array.from({ length: 20 }, (_, index) => `${index},`),
      chunkIntervalMs: 10_000,
    });

    const outcome = await settleAfter(
      generateTextWithIdleDeadline(fake.provider, baseReq),
      LONG_TEXT_GENERATION_MAX_MS
    );

    expect(
      outcome.status === 'resolved' ? outcome.text : describeOutcome(outcome),
      `expected the 200000 ms streamed reply collected whole | received ${describeOutcome(outcome)}`
    ).toBe(Array.from({ length: 20 }, (_, index) => `${index},`).join(''));
    expect(fake.generateTextRequests).toHaveLength(0);
  });

  it('cuts a vendor that goes silent after the idle deadline, even if it ignores its signal', async () => {
    const fake = createFakeLongTextProvider({
      chunks: ['first ', 'second ', 'never'],
      chunkIntervalMs: 10_000,
      stallAfterChunks: 2,
    });

    const outcome = await settleAfter(
      generateTextWithIdleDeadline(fake.provider, baseReq),
      LONG_TEXT_GENERATION_MAX_MS
    );

    expect(
      outcome.status === 'rejected' && outcome.error instanceof GenerationDeadlineError,
      `expected GenerationDeadlineError | received ${describeOutcome(outcome)}`
    ).toBe(true);
    expect((outcome as { error: Error }).error.message).toBe(
      `openai-compatible text generation (no output) exceeded the ${TEXT_GENERATION_TIMEOUT_MS} ms deadline.`
    );
    expect(fake.generateTextStreamRequests[0]?.signal?.aborted).toBe(true);
  });

  it('stops a reply that keeps arriving once it passes the hard cap', async () => {
    const fake = createFakeLongTextProvider({
      chunks: Array.from({ length: 100 }, () => 'x'),
      chunkIntervalMs: 10_000,
    });

    const outcome = await settleAfter(
      generateTextWithIdleDeadline(fake.provider, baseReq, { maxDurationMs: 60_000 }),
      120_000
    );

    expect(
      outcome.status === 'rejected' &&
        outcome.error instanceof GenerationDeadlineError &&
        outcome.error.timeoutMs === 60_000,
      `expected GenerationDeadlineError at the 60000 ms cap | received ${describeOutcome(outcome)}`
    ).toBe(true);
  });

  it('hands the hard cap to the stream as its whole-response deadline', async () => {
    const fake = createFakeLongTextProvider({ chunks: ['ok'], chunkIntervalMs: 1_000 });

    await settleAfter(generateTextWithIdleDeadline(fake.provider, baseReq), 5_000);

    expect(fake.generateTextStreamRequests[0]?.timeoutMs).toBe(LONG_TEXT_GENERATION_MAX_MS);
  });

  it('aborts the vendor call and rejects with the abort reason when the caller aborts', async () => {
    const fake = createFakeLongTextProvider({
      chunks: Array.from({ length: 20 }, () => 'x'),
      chunkIntervalMs: 10_000,
    });
    const callerAbort = new AbortController();

    const call = generateTextWithIdleDeadline(fake.provider, {
      ...baseReq,
      signal: callerAbort.signal,
    });
    await advanceFakeClock(15_000);
    callerAbort.abort(new Error('client disconnected'));
    const outcome = await settleAfter(call, 30_000);

    expect(fake.generateTextStreamRequests[0]?.signal?.aborted).toBe(true);
    expect(
      outcome.status === 'rejected' && (outcome.error as Error).message,
      `expected rejection "client disconnected" | received ${describeOutcome(outcome)}`
    ).toBe('client disconnected');
  });

  it('rejects without calling the vendor when the caller already aborted', async () => {
    const fake = createFakeLongTextProvider({ chunks: ['x'], chunkIntervalMs: 1_000 });

    const outcome = await settleAfter(
      generateTextWithIdleDeadline(fake.provider, { ...baseReq, signal: AbortSignal.abort() }),
      5_000
    );

    expect(outcome.status).toBe('rejected');
    expect(fake.generateTextStreamRequests).toHaveLength(0);
  });

  it('turns an error chunk into a rejection carrying its message', async () => {
    const provider = createScriptedStreamProvider([
      { type: 'text', text: 'partial', done: false },
      { type: 'error', content: 'vendor refused the request', done: true },
    ]);

    const outcome = await settleAfter(generateTextWithIdleDeadline(provider, baseReq), 5_000);

    expect(
      outcome.status === 'rejected' && (outcome.error as Error).message,
      `expected rejection "vendor refused the request" | received ${describeOutcome(outcome)}`
    ).toBe('vendor refused the request');
  });

  it('ignores thinking chunks in the text but counts them as progress', async () => {
    const provider = createScriptedStreamProvider([
      { type: 'thinking', text: 'hmm', done: false },
      { type: 'text', text: 'answer', done: false },
      { type: 'text', text: '', done: true },
    ]);

    const outcome = await settleAfter(generateTextWithIdleDeadline(provider, baseReq), 5_000);

    expect(outcome.status === 'resolved' && outcome.text).toBe('answer');
  });

  it('rejects an empty reply, naming the model', async () => {
    const provider = createScriptedStreamProvider([{ type: 'text', text: '', done: true }]);

    const outcome = await settleAfter(generateTextWithIdleDeadline(provider, baseReq), 5_000);

    expect(
      outcome.status === 'rejected' && (outcome.error as Error).message,
      `expected the empty-reply message | received ${describeOutcome(outcome)}`
    ).toBe('No text returned from openai-compatible model "test-model".');
  });

  it('falls back to generateText under the hard cap when the provider has no stream', async () => {
    const requests: TextGenerationRequest[] = [];
    const provider: AIProvider = {
      providerType: 'openai-compatible',
      generateText: (req) => {
        requests.push(req);
        return Promise.resolve({ text: 'whole reply' });
      },
      listModels: () => Promise.resolve([]),
      validateApiKey: () => Promise.resolve(),
      resolveApiKey: () => Promise.resolve('test-key'),
    };

    const outcome = await settleAfter(generateTextWithIdleDeadline(provider, baseReq), 5_000);

    expect(outcome.status === 'resolved' && outcome.text).toBe('whole reply');
    expect(requests[0]?.timeoutMs).toBe(LONG_TEXT_GENERATION_MAX_MS);
  });
});
