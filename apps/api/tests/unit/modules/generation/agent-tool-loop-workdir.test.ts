import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { StreamTextTurnSession } from '../../../../src/modules/generation/application/stream-text-turn-stages';
import type { AgentTurnRequest } from '../../../../src/services/providers/types';

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

function createDbMock() {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: () => Promise.resolve({ lastProviderState: null }),
        }),
      }),
    }),
  };
}

describe('runAgentToolLoop', () => {
  afterEach(() => {
    mock.restore();
  });

  it('forwards workdir and workdirPolicy on AgentTurnRequest', async () => {
    await mockMessageRepository();
    const { runAgentToolLoop } = await import(
      '../../../../src/modules/generation/application/stream-text-turn-stages'
    );

    let captured: AgentTurnRequest | undefined;
    const workdir = '/tmp/chat-workdir';
    const workdirPolicy = { root: workdir, restricted: true as const };

    const session = {
      chatId: 'chat-agent-loop',
      userId: 'user-agent-loop',
      userMsgId: 'user-msg',
      aiMsgId: 'ai-msg',
      workdir,
      workdirPolicy,
      effectivePrompt: 'Hi',
      effectiveSystemPrompt: 'You are helpful',
      continuationSystemPrompt: 'You are helpful',
      toolDefs: [],
      runtimeAttachments: [],
      thinkingEnabled: true,
      reasoningEffort: 'medium',
      multiAgentSettings: { traceVisibility: 'off' },
      agentRuntime: {
        profile: { id: 'default' },
        runtimeHash: 'hash-1',
        runtimeSettings: { maxToolIterations: 3 },
        toolSettingsByName: new Map(),
      },
      resolvedModel: {
        modelId: 'test-model',
        capabilities: { text: true, image: false, streaming: true, tools: true },
      },
      provider: {
        providerType: 'cursor',
        // biome-ignore lint/correctness/useYield: capture-only fake provider stream
        generateAgentTurnStream: function* (req: AgentTurnRequest) {
          captured = req;
        },
        listModels: () => Promise.resolve([]),
        validateApiKey: () => Promise.resolve(),
        resolveApiKey: () => Promise.resolve('key'),
      },
      input: { chatId: 'chat-agent-loop', userId: 'user-agent-loop', prompt: 'Hi' },
      db: createDbMock(),
      executionState: { durableProviderState: null, turnLocalState: null },
      checkpointWriter: { checkpoint: () => Promise.resolve(false) },
      allParts: [],
      fullText: '',
    } as unknown as StreamTextTurnSession;

    for await (const _event of runAgentToolLoop(session)) {
      // consume full loop
    }

    expect(captured?.workdir).toBe(workdir);
    expect(captured?.workdirPolicy).toEqual(workdirPolicy);
  });
});
