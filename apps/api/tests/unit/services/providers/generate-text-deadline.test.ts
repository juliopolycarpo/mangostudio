import { describe, expect, it } from 'bun:test';

import { generateAnthropicText } from '../../../../src/services/providers/anthropic/index';
import {
  GenerationDeadlineError,
  TEXT_GENERATION_TIMEOUT_MS,
  withGenerationDeadline,
} from '../../../../src/services/providers/core/generation-deadline';
import { generateGeminiText } from '../../../../src/services/providers/gemini/text';
import { generateChatCompletionText } from '../../../../src/services/providers/openai/chat-completions';
import type { TextGenerationRequest } from '../../../../src/services/providers/types';

const DEADLINE_MS = 25;
/** Longer than any deadline here: a call still pending after it never got one. */
const HANG_GUARD_MS = 1_000;

const baseReq: TextGenerationRequest = {
  userId: 'test-user',
  history: [],
  prompt: 'Name this chat',
  modelName: 'test-model',
};

/**
 * What the call did, or a message naming the hang. The guard is the failure:
 * a call that reaches it was never given a deadline.
 */
async function settle(call: Promise<unknown>): Promise<Error | string> {
  return await Promise.race([
    call.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
    ),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve(`still pending after ${HANG_GUARD_MS}ms`), HANG_GUARD_MS)
    ),
  ]);
}

/** Rejects with `Request was aborted.` when `signal` aborts, as the vendor SDKs do. */
function pendingUntilAborted<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')), {
      once: true,
    });
  });
}

/** An OpenAI-shaped client whose completion never answers. */
function createSilentChatCompletionsClient(): Parameters<typeof generateChatCompletionText>[0] {
  return {
    chat: {
      completions: {
        create: (_params: unknown, options?: { signal?: AbortSignal }) =>
          pendingUntilAborted(options?.signal),
      },
    },
  } as unknown as Parameters<typeof generateChatCompletionText>[0];
}

/** An Anthropic-shaped client whose message never answers. */
function createSilentAnthropicClient(): Parameters<typeof generateAnthropicText>[0] {
  return {
    messages: {
      create: (_params: unknown, options?: { signal?: AbortSignal }) =>
        pendingUntilAborted(options?.signal),
    },
  } as unknown as Parameters<typeof generateAnthropicText>[0];
}

/** A Gemini-shaped client whose generateContent never answers. */
function createSilentGeminiClient(): NonNullable<Parameters<typeof generateGeminiText>[6]> {
  return {
    models: {
      generateContent: (params: { config?: { abortSignal?: AbortSignal } }) =>
        pendingUntilAborted(params.config?.abortSignal),
    },
  } as unknown as NonNullable<Parameters<typeof generateGeminiText>[6]>;
}

function expectDeadline(outcome: Error | string, call: string): void {
  expect(
    outcome instanceof GenerationDeadlineError ? outcome.message : outcome,
    `expected GenerationDeadlineError "${call} exceeded the ${DEADLINE_MS} ms deadline." | received ${
      outcome instanceof Error ? `${outcome.name}: ${outcome.message}` : outcome
    }`
  ).toBe(`${call} exceeded the ${DEADLINE_MS} ms deadline.`);
}

describe('withGenerationDeadline', () => {
  it('rejects at the deadline even when the call ignores its signal', async () => {
    const outcome = await settle(
      withGenerationDeadline(
        'Fake generateText',
        undefined,
        DEADLINE_MS,
        () => new Promise(() => {})
      )
    );

    expectDeadline(outcome, 'Fake generateText');
    expect(outcome).toMatchObject({ call: 'Fake generateText', timeoutMs: DEADLINE_MS });
  });

  it('names the deadline when the call rejects with its own abort error first', async () => {
    const outcome = await settle(
      withGenerationDeadline('Fake generateText', undefined, DEADLINE_MS, (signal) =>
        pendingUntilAborted(signal)
      )
    );

    expectDeadline(outcome, 'Fake generateText');
  });

  it('hands the caller their own abort back, not a deadline error', async () => {
    const controller = new AbortController();
    const call = withGenerationDeadline('Fake generateText', controller.signal, 5_000, (signal) =>
      pendingUntilAborted(signal)
    );
    controller.abort();

    const outcome = await settle(call);

    expect(
      outcome instanceof Error ? outcome.message : outcome,
      'expected the SDK abort error to pass through | received a deadline error or a hang'
    ).toBe('Request was aborted.');
  });

  it('returns the result of a call that finishes in time', async () => {
    const result = await withGenerationDeadline('Fake generateText', undefined, 5_000, () =>
      Promise.resolve('titled')
    );

    expect(result).toBe('titled');
  });

  it('defaults the shared deadline to two minutes', () => {
    expect(TEXT_GENERATION_TIMEOUT_MS).toBe(120_000);
  });
});

describe('generateText deadlines', () => {
  it('bounds an OpenAI reply that never comes', async () => {
    const outcome = await settle(
      generateChatCompletionText(createSilentChatCompletionsClient(), baseReq, 'empty', {
        timeoutMs: DEADLINE_MS,
      })
    );

    expectDeadline(outcome, 'OpenAI generateText');
  });

  it('names the OpenAI-compatible call when that provider passes its own label', async () => {
    const outcome = await settle(
      generateChatCompletionText(createSilentChatCompletionsClient(), baseReq, 'empty', {
        timeoutMs: DEADLINE_MS,
        call: 'OpenAI-compatible generateText',
      })
    );

    expectDeadline(outcome, 'OpenAI-compatible generateText');
  });

  it('takes the budget a call site names on the request', async () => {
    const outcome = await settle(
      generateChatCompletionText(
        createSilentChatCompletionsClient(),
        { ...baseReq, timeoutMs: DEADLINE_MS },
        'empty'
      )
    );

    expectDeadline(outcome, 'OpenAI generateText');
  });

  it('takes the request budget for an Anthropic reply too', async () => {
    const outcome = await settle(
      generateAnthropicText(createSilentAnthropicClient(), { ...baseReq, timeoutMs: DEADLINE_MS })
    );

    expectDeadline(outcome, 'Anthropic generateText');
  });

  it('bounds an Anthropic reply that never comes', async () => {
    const outcome = await settle(
      generateAnthropicText(createSilentAnthropicClient(), baseReq, { timeoutMs: DEADLINE_MS })
    );

    expectDeadline(outcome, 'Anthropic generateText');
  });

  it('bounds a Gemini reply that never comes', async () => {
    const outcome = await settle(
      generateGeminiText(
        baseReq.userId,
        baseReq.history,
        baseReq.prompt,
        undefined,
        baseReq.modelName,
        {},
        createSilentGeminiClient(),
        { timeoutMs: DEADLINE_MS }
      )
    );

    expectDeadline(outcome, 'Gemini generateText');
  });

  it('lets a caller cancel a Gemini reply, which the call used to ignore', async () => {
    const controller = new AbortController();
    const call = generateGeminiText(
      baseReq.userId,
      baseReq.history,
      baseReq.prompt,
      undefined,
      baseReq.modelName,
      {},
      createSilentGeminiClient(),
      { signal: controller.signal, timeoutMs: 5_000 }
    );
    controller.abort();

    const outcome = await settle(call);

    expect(
      outcome instanceof Error ? outcome.message : outcome,
      'expected the caller abort to reach generateContent | received a hang or a deadline error'
    ).toBe('Request was aborted.');
  });
});
