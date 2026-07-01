import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { StreamTextTurnSession } from '../../../../src/modules/generation/application/stream-text-turn-stages';
import type { StreamingChunk } from '../../../../src/services/providers/types';

function createSession(chunks: StreamingChunk[]): StreamTextTurnSession {
  return {
    chatId: 'chat-legacy-stream',
    userId: 'user-legacy-stream',
    userMsgId: 'user-message',
    effectivePrompt: 'Hello',
    effectiveSystemPrompt: undefined,
    resolvedModel: {
      modelId: 'cursor-model',
      capabilities: { text: true, image: false, streaming: true },
    },
    provider: {
      providerType: 'cursor',
      generateText: () => Promise.resolve({ text: '' }),
      generateTextStream: async function* () {
        await Promise.resolve();
        for (const chunk of chunks) yield chunk;
      },
      listModels: () => Promise.resolve([]),
      validateApiKey: () => Promise.resolve(),
      resolveApiKey: () => Promise.resolve('cursor-key'),
    },
    agentRuntime: {
      runtimeSettings: {},
    },
    input: {},
    db: {},
    allParts: [],
    fullText: '',
    runtimeAttachments: [],
    thinkingEnabled: true,
    reasoningEffort: 'medium',
  } as unknown as StreamTextTurnSession;
}

async function mockMessageRepository(): Promise<void> {
  await mock.module('../../../../src/modules/messages/infrastructure/message-repository', () => ({
    insertMessage: () => Promise.resolve(),
    updateMessage: () => Promise.resolve(),
    listByChatId: () => Promise.resolve([]),
    loadHistory: () => Promise.resolve([]),
    loadRichHistory: () => Promise.resolve([]),
    verifyMessageOwnership: () => Promise.resolve(true),
    listLegacyGalleryImages: () => Promise.resolve([]),
  }));
}

describe('runLegacyTextStream', () => {
  afterEach(() => {
    mock.restore();
  });

  it('throws provider error chunks instead of completing successfully', async () => {
    await mockMessageRepository();
    const { runLegacyTextStream } = await import(
      '../../../../src/modules/generation/application/stream-text-turn-stages'
    );
    const session = createSession([
      { type: 'error', content: 'Cursor agent run failed.', done: true },
    ]);

    await expect(async () => {
      for await (const _event of runLegacyTextStream(session)) {
        // consume the stream
      }
    }).toThrow('Cursor agent run failed.');
  });

  it('surfaces Cursor internal tool activity as a system event', async () => {
    await mockMessageRepository();
    const { runLegacyTextStream } = await import(
      '../../../../src/modules/generation/application/stream-text-turn-stages'
    );
    const session = createSession([
      { type: 'tool_call', toolCallId: 'tool-1', name: 'read_file', done: false },
      { type: 'text', text: 'done', done: false },
      { type: 'text', text: '', done: true },
    ]);

    const events = [];
    for await (const event of runLegacyTextStream(session)) events.push(event);

    expect(events).toContainEqual({
      type: 'system_event',
      event: 'cursor_internal_tool_call',
      detail: 'read_file',
    });
    expect(session.allParts).toContainEqual({
      type: 'system_event',
      event: 'cursor_internal_tool_call',
      detail: 'read_file',
    });
    expect(session.fullText).toBe('done');
  });
});
