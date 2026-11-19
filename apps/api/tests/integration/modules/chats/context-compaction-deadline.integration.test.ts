/**
 * Compaction and summarize-to-new-chat wait on one long summary. Like
 * `POST /api/respond`, the bound has to be the vendor's silence, not a
 * whole-response deadline, and a client that hangs up cancels the vendor call.
 * Runs on fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import { getDb } from '../../../../src/db/database';
import {
  compactChatUseCase,
  summarizeToNewChatUseCase,
} from '../../../../src/modules/chats/application/context-compaction';
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
  | { readonly status: 'resolved' }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'pending'; readonly elapsedMs: number };

/** Advances the fake clock until `call` settles or the limit passes. */
async function runOnFakeClock(call: Promise<unknown>): Promise<Outcome> {
  let outcome: Outcome | undefined;
  call.then(
    () => (outcome = { status: 'resolved' }),
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

async function seedCompactableChat(options: FakeLongTextProviderOptions) {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  const modelId = `compaction-deadline-model-${chat.id}`;
  await insertTestConnector(user.id, { enabledModels: [modelId] });
  await getDb()
    .insertInto('messages')
    .values({
      id: `compaction-deadline-seed-${chat.id}`,
      chatId: chat.id,
      role: 'user',
      text: 'Where did we leave off?',
      timestamp: Date.now() - 1000,
      isGenerating: 0,
      interactionMode: 'chat',
    })
    .execute();
  const fake = createFakeLongTextProvider(options);
  try {
    previousProvider = getProvider('openai-compatible');
  } catch {
    previousProvider = null;
  }
  registerProvider(fake.provider);
  return { userId: user.id, chatId: chat.id, modelId, fake };
}

const progressingReply: FakeLongTextProviderOptions = {
  chunks: Array.from({ length: CHUNK_COUNT }, (_, index) => `summary-${index} `),
  chunkIntervalMs: CHUNK_INTERVAL_MS,
};

describe('compaction deadline', () => {
  it('keeps a compaction summary that is still arriving past the shared 120 s deadline', async () => {
    const { userId, chatId, modelId } = await seedCompactableChat(progressingReply);

    const outcome = await runOnFakeClock(
      compactChatUseCase({ chatId, userId, model: modelId }, getDb())
    );

    expect(
      outcome.status,
      `expected the ${CHUNK_COUNT * CHUNK_INTERVAL_MS} ms summary to be persisted | received ${describeOutcome(outcome)}`
    ).toBe('resolved');
  });

  it('keeps a summarize-to-new-chat summary that is still arriving past 120 s', async () => {
    const { userId, chatId, modelId } = await seedCompactableChat(progressingReply);

    const outcome = await runOnFakeClock(
      summarizeToNewChatUseCase({ chatId, userId, model: modelId }, getDb())
    );

    expect(
      outcome.status,
      `expected the ${CHUNK_COUNT * CHUNK_INTERVAL_MS} ms summary to be persisted | received ${describeOutcome(outcome)}`
    ).toBe('resolved');
  });

  it('cuts a compaction whose vendor went silent', async () => {
    const { userId, chatId, modelId } = await seedCompactableChat({
      chunks: ['first ', 'second ', 'never arrives'],
      chunkIntervalMs: CHUNK_INTERVAL_MS,
      stallAfterChunks: 2,
    });

    const outcome = await runOnFakeClock(
      compactChatUseCase({ chatId, userId, model: modelId }, getDb())
    );

    expect(
      outcome.status === 'rejected' && outcome.error instanceof GenerationDeadlineError,
      `expected GenerationDeadlineError after the vendor went silent | received ${describeOutcome(outcome)}`
    ).toBe(true);
  });

  it('cancels the vendor call when the client disconnects during a compaction', async () => {
    const { userId, chatId, modelId, fake } = await seedCompactableChat(progressingReply);
    const clientDisconnect = new AbortController();

    const call = compactChatUseCase(
      { chatId, userId, model: modelId, signal: clientDisconnect.signal },
      getDb()
    );
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
      `expected the compaction to reject after the client disconnect | received ${describeOutcome(outcome)}`
    ).toBe('rejected');
  });
});
