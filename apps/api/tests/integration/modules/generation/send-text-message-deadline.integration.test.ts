/**
 * `POST /api/respond` runs one long reply. The only bound on it used to be Bun's
 * 255 s handler limit, and a whole-response 120 s deadline would cut a reply that
 * is still arriving. These tests run the reply on fake timers: a slow but
 * progressing vendor must survive, a silent one must be cut, and a client that
 * hangs up must cancel the vendor call.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import { getDb } from '../../../../src/db/database';
import { sendTextMessage } from '../../../../src/modules/generation/application/send-text-message';
import { GenerationDeadlineError } from '../../../../src/services/providers/core/generation-deadline';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type { AIProvider } from '../../../../src/services/providers/types';
import { insertTestChat, insertTestConnector, insertTestUser } from '../../../support/factories';
import { advanceFakeClock } from '../../../support/fake-clock';
import {
  createFakeLongTextProvider,
  type FakeLongTextProviderOptions,
} from '../../../support/providers/fake-long-text-provider';

/** Longer than the shared 120 s whole-response deadline, shorter than Bun's 255 s handler limit. */
const CHUNK_COUNT = 20;
const CHUNK_INTERVAL_MS = 10_000;
const FAKE_CLOCK_STEP_MS = 1_000;
const FAKE_CLOCK_LIMIT_MS = 600_000;

let previousProvider: AIProvider | null = null;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
});

type Outcome =
  | { readonly status: 'resolved'; readonly value: Awaited<ReturnType<typeof sendTextMessage>> }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'pending'; readonly elapsedMs: number };

/** Advances the fake clock until `call` settles or the limit passes. */
async function runOnFakeClock(call: ReturnType<typeof sendTextMessage>): Promise<Outcome> {
  let outcome: Outcome | undefined;
  call.then(
    (value) => (outcome = { status: 'resolved', value }),
    (error: unknown) => (outcome = { status: 'rejected', error })
  );
  let elapsedMs = 0;
  while (!outcome && elapsedMs < FAKE_CLOCK_LIMIT_MS) {
    await advanceFakeClock(FAKE_CLOCK_STEP_MS);
    elapsedMs += FAKE_CLOCK_STEP_MS;
  }
  return outcome ?? { status: 'pending', elapsedMs };
}

function describeOutcome(outcome: Outcome): string {
  if (outcome.status === 'resolved') return 'resolved';
  if (outcome.status === 'pending') return `still pending after ${outcome.elapsedMs} ms`;
  return outcome.error instanceof Error
    ? `${outcome.error.name}: ${outcome.error.message}`
    : String(outcome.error);
}

async function seedRespondTurn(options: FakeLongTextProviderOptions): Promise<{
  userId: string;
  chatId: string;
  modelId: string;
  fake: ReturnType<typeof createFakeLongTextProvider>;
}> {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  const modelId = `respond-deadline-model-${chat.id}`;
  await insertTestConnector(user.id, { enabledModels: [modelId] });
  const fake = createFakeLongTextProvider(options);
  try {
    previousProvider = getProvider('openai-compatible');
  } catch {
    previousProvider = null;
  }
  registerProvider(fake.provider);
  return { userId: user.id, chatId: chat.id, modelId, fake };
}

describe('sendTextMessage deadline', () => {
  it('keeps a reply that is still arriving past the shared 120 s deadline', async () => {
    const chunks = Array.from({ length: CHUNK_COUNT }, (_, index) => `part-${index} `);
    const { userId, chatId, modelId } = await seedRespondTurn({
      chunks,
      chunkIntervalMs: CHUNK_INTERVAL_MS,
    });

    const outcome = await runOnFakeClock(
      sendTextMessage({ chatId, userId, prompt: 'Write a long answer.', model: modelId }, getDb())
    );

    expect(
      outcome.status === 'resolved' ? outcome.value.aiMessage.text : describeOutcome(outcome),
      `expected the ${CHUNK_COUNT * CHUNK_INTERVAL_MS} ms reply to be persisted whole | received ${describeOutcome(outcome)}`
    ).toBe(chunks.join(''));
  });

  it('cuts a reply whose vendor went silent', async () => {
    const { userId, chatId, modelId } = await seedRespondTurn({
      chunks: ['first ', 'second ', 'never arrives'],
      chunkIntervalMs: CHUNK_INTERVAL_MS,
      stallAfterChunks: 2,
    });

    const outcome = await runOnFakeClock(
      sendTextMessage({ chatId, userId, prompt: 'Write an answer.', model: modelId }, getDb())
    );

    expect(
      outcome.status === 'rejected' && outcome.error instanceof GenerationDeadlineError,
      `expected GenerationDeadlineError after the vendor went silent | received ${describeOutcome(outcome)}`
    ).toBe(true);
  });

  it('cancels the vendor call when the client disconnects', async () => {
    const { userId, chatId, modelId, fake } = await seedRespondTurn({
      chunks: Array.from({ length: CHUNK_COUNT }, (_, index) => `part-${index} `),
      chunkIntervalMs: CHUNK_INTERVAL_MS,
    });
    const clientDisconnect = new AbortController();

    const call = sendTextMessage(
      {
        chatId,
        userId,
        prompt: 'Write a long answer.',
        model: modelId,
        signal: clientDisconnect.signal,
      },
      getDb()
    );
    // Let the turn reach the vendor, then hang up mid-reply.
    await advanceFakeClock(CHUNK_INTERVAL_MS * 2);
    clientDisconnect.abort();
    const outcome = await runOnFakeClock(call);

    const vendorRequest = [...fake.generateTextRequests, ...fake.generateTextStreamRequests][0];
    expect(
      vendorRequest?.signal?.aborted,
      `expected the vendor request signal to be aborted after the client disconnect | received ${
        vendorRequest ? `signal aborted=${String(vendorRequest.signal?.aborted)}` : 'no vendor call'
      }`
    ).toBe(true);
    expect(
      outcome.status,
      `expected the turn to reject after the client disconnect | received ${describeOutcome(outcome)}`
    ).toBe('rejected');
  });
});
