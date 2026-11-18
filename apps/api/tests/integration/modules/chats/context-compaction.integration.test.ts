import { afterEach, describe, expect, it } from 'bun:test';

import { getDb } from '../../../../src/db/database';
import {
  compactChatUseCase,
  summarizeToNewChatUseCase,
} from '../../../../src/modules/chats/application/context-compaction';
import { insertCheckpointDelta } from '../../../../src/modules/messages/infrastructure/message-checkpoint-deltas';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type { AIProvider } from '../../../../src/services/providers/types';
import { insertTestChat, insertTestConnector, insertTestUser } from '../../../support/factories';
import {
  installRecordingRealtimeBus,
  restoreRealtimeBus,
} from '../../../support/mocks/recording-realtime-bus';

let previousOpenAICompatibleProvider: AIProvider | null = null;

afterEach(() => {
  restoreRealtimeBus();

  if (previousOpenAICompatibleProvider) {
    registerProvider(previousOpenAICompatibleProvider);
  }
  previousOpenAICompatibleProvider = null;
});

function registerSummaryProvider(summaryText: string): void {
  try {
    previousOpenAICompatibleProvider = getProvider('openai-compatible');
  } catch {
    previousOpenAICompatibleProvider = null;
  }

  registerProvider({
    providerType: 'openai-compatible',
    generateText: () => Promise.resolve({ text: summaryText }),
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('test-key'),
  });
}

/** A chat with one prior message, so `compactChatUseCase` has history to summarize. */
async function seedCompactableChat(modelId: string): Promise<{ userId: string; chatId: string }> {
  const db = getDb();
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  await insertTestConnector(user.id, { enabledModels: [modelId] });
  await db
    .insertInto('messages')
    .values({
      id: `compaction-seed-${chat.id}`,
      chatId: chat.id,
      role: 'user',
      text: 'Where did we leave off?',
      timestamp: Date.now() - 1000,
      isGenerating: 0,
      interactionMode: 'chat',
    })
    .execute();

  return { userId: user.id, chatId: chat.id };
}

describe('compactChatUseCase realtime invalidation', () => {
  it('publishes exactly one chats invalidation for the acting user', async () => {
    const db = getDb();
    const modelId = `compaction-model-${Date.now()}`;
    registerSummaryProvider('Summary of the conversation.');
    const { userId, chatId } = await seedCompactableChat(modelId);
    const bus = installRecordingRealtimeBus();

    await compactChatUseCase({ chatId, userId, model: modelId }, db);

    expect(bus.chatListFramesFor(userId)).toHaveLength(1);
    expect(bus.activityFramesFor(userId)).toHaveLength(0);
  });
});

describe('summarizeToNewChatUseCase realtime invalidation', () => {
  it('publishes exactly one chats invalidation for the acting user', async () => {
    const db = getDb();
    const modelId = `handoff-model-${Date.now()}`;
    registerSummaryProvider('Summary for handoff.');
    const { userId, chatId } = await seedCompactableChat(modelId);
    const bus = installRecordingRealtimeBus();

    await summarizeToNewChatUseCase({ chatId, userId, model: modelId }, db);

    expect(bus.chatListFramesFor(userId)).toHaveLength(1);
    expect(bus.activityFramesFor(userId)).toHaveLength(0);
  });
});

describe('compactChatUseCase during a generating turn', () => {
  it('summarises the turn as its last checkpoint left it, not as its last full rewrite', async () => {
    const db = getDb();
    const modelId = `compaction-generating-${Date.now()}`;
    const prompts: string[] = [];
    previousOpenAICompatibleProvider = (() => {
      try {
        return getProvider('openai-compatible');
      } catch {
        return null;
      }
    })();
    registerProvider({
      providerType: 'openai-compatible',
      generateText: (request) => {
        prompts.push(request.prompt);
        return Promise.resolve({ text: 'Summary.' });
      },
      listModels: () => Promise.resolve([]),
      validateApiKey: () => Promise.resolve(),
      resolveApiKey: () => Promise.resolve('test-key'),
    });
    const { userId, chatId } = await seedCompactableChat(modelId);
    // The row holds the turn's first checkpoint; the rest of the answer is in deltas.
    const messageId = `compaction-generating-turn-${chatId}`;
    await db
      .insertInto('messages')
      .values({
        id: messageId,
        chatId,
        role: 'ai',
        text: 'The answer begins',
        timestamp: Date.now() - 500,
        isGenerating: 1,
        interactionMode: 'agent',
        parts: JSON.stringify([{ type: 'text', text: 'The answer begins' }]),
      })
      .execute();
    await insertCheckpointDelta(
      {
        messageId,
        seq: 1,
        deltaJson: JSON.stringify({
          text: ' and then keeps going to its end',
          ops: [{ i: 0, append: ' and then keeps going to its end' }],
        }),
      },
      db
    );

    await compactChatUseCase({ chatId, userId, model: modelId }, db);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Assistant: The answer begins and then keeps going to its end');
  });
});
