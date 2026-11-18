/**
 * The local runner's terminal paths each tell the chat list to refetch: a turn
 * that ends exhausted, errored or interrupted changes the chat's recency and
 * the row's state just as a completed one does. Nothing else covers it, so a
 * refactor that drops or doubles one of the publishes would leave every suite
 * green and the list stale.
 *
 * Each case drives a real finalizer against the migrated test database and
 * reads the frames off the recording bus, so a publish that fires for a turn
 * whose row another writer already finalized shows up as an extra frame.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getDb } from '../../../../src/db/database';
import {
  finalizeInterruptedTurn,
  finalizeToolLoopExhausted,
  finalizeTurnError,
  type StreamTextTurnSession,
} from '../../../../src/modules/generation/application/stream-text-turn-stages';
import { insertMessage } from '../../../../src/modules/messages/infrastructure/message-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';
import {
  installRecordingRealtimeBus,
  type RecordingRealtimeBus,
  restoreRealtimeBus,
} from '../../../support/mocks/recording-realtime-bus';

/** Named fake for the checkpoint writer: the finalizers only call `prepareFinal`. */
class NoopCheckpointWriter {
  async prepareFinal(): Promise<void> {}
}

interface FinalizerFixture {
  session: StreamTextTurnSession;
  userId: string;
  aiMsgId: string;
}

let bus: RecordingRealtimeBus;
let messageSeq = 0;

/**
 * A session with the durable pieces real (user, chat, in-flight assistant row)
 * and the provider-facing ones absent, which no finalizer reads.
 */
async function createFinalizerFixture(signal?: AbortSignal): Promise<FinalizerFixture> {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  messageSeq += 1;
  const aiMsgId = `ai-finalizer-${messageSeq}`;
  await insertMessage(
    {
      id: aiMsgId,
      chatId: chat.id,
      role: 'ai',
      text: '',
      timestamp: Date.now(),
      isGenerating: true,
      interactionMode: 'chat',
    },
    getDb()
  );

  const session = {
    db: getDb(),
    input: { chatId: chat.id, userId: user.id, prompt: 'Hi' },
    chatId: chat.id,
    userId: user.id,
    aiMsgId,
    signal,
    startTime: Date.now(),
    allParts: [],
    fullText: '',
    generatedImageArtifacts: [],
    executionState: { durableProviderState: null, turnLocalState: null },
    resolvedModel: { modelId: 'finalizer-model' },
    agentRuntime: { runtimeSettings: {} },
    checkpointWriter: new NoopCheckpointWriter(),
  } as unknown as StreamTextTurnSession;

  return { session, userId: user.id, aiMsgId };
}

async function isStillGenerating(aiMsgId: string): Promise<boolean> {
  const row = await getDb()
    .selectFrom('messages')
    .select('isGenerating')
    .where('id', '=', aiMsgId)
    .executeTakeFirstOrThrow();
  return row.isGenerating === 1;
}

async function drain(events: AsyncGenerator<unknown>): Promise<void> {
  for await (const _event of events) {
    // Only the side effects matter here.
  }
}

function expectOneActivityFrame(userId: string, terminal: string): void {
  const received = bus.activityFramesFor(userId).length;
  expect(received, `(${terminal}): expected activity frames: 1 | received: ${received}`).toBe(1);
}

beforeEach(() => {
  bus = installRecordingRealtimeBus();
});

afterEach(() => {
  restoreRealtimeBus();
});

describe('local turn finalizers publish one activity frame', () => {
  it('finalizeToolLoopExhausted', async () => {
    const { session, userId, aiMsgId } = await createFinalizerFixture();

    await drain(finalizeToolLoopExhausted(session, 2));

    expect(await isStillGenerating(aiMsgId)).toBe(false);
    expectOneActivityFrame(userId, 'tool loop exhausted');
  });

  it('finalizeTurnError', async () => {
    const { session, userId, aiMsgId } = await createFinalizerFixture();

    await drain(finalizeTurnError(session, new Error('provider exploded')));

    expect(await isStillGenerating(aiMsgId)).toBe(false);
    expectOneActivityFrame(userId, 'turn error');
  });

  it('finalizeTurnError on an aborted signal publishes once, through the interrupted path', async () => {
    const controller = new AbortController();
    const { session, userId, aiMsgId } = await createFinalizerFixture(controller.signal);
    controller.abort('client_disconnect');

    await drain(finalizeTurnError(session, new Error('aborted')));

    expect(await isStillGenerating(aiMsgId)).toBe(false);
    expectOneActivityFrame(userId, 'turn error after abort');
  });

  for (const reason of ['client_disconnect', 'user_cancelled', 'unknown'] as const) {
    it(`finalizeInterruptedTurn (${reason})`, async () => {
      const { session, userId, aiMsgId } = await createFinalizerFixture();

      await finalizeInterruptedTurn(session, reason);

      expect(await isStillGenerating(aiMsgId)).toBe(false);
      expectOneActivityFrame(userId, `interrupted: ${reason}`);
    });
  }
});

describe('local turn finalizers stay quiet when another writer already finalized the row', () => {
  it('publishes nothing for a second terminal on the same turn', async () => {
    const { session, userId } = await createFinalizerFixture();
    await finalizeInterruptedTurn(session, 'client_disconnect');

    await drain(finalizeToolLoopExhausted(session, 1));
    await drain(finalizeTurnError(session, new Error('late failure')));
    await finalizeInterruptedTurn(session, 'user_cancelled');

    expectOneActivityFrame(userId, 'first terminal only');
  });
});
