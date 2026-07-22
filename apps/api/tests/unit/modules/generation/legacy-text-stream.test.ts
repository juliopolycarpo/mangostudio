import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { StreamTextTurnSession } from '../../../../src/modules/generation/application/stream-text-turn-stages';
import type {
  StreamingChunk,
  TextGenerationRequest,
} from '../../../../src/services/providers/types';

function createSession(
  chunks: StreamingChunk[],
  options: {
    onRequest?: (req: TextGenerationRequest) => void;
    toolSettingsByName?: Map<string, { enabled: boolean; parameters: Record<string, unknown> }>;
  } = {}
): StreamTextTurnSession {
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
      generateTextStream: async function* (req: TextGenerationRequest) {
        options.onRequest?.(req);
        await Promise.resolve();
        for (const chunk of chunks) yield chunk;
      },
      listModels: () => Promise.resolve([]),
      validateApiKey: () => Promise.resolve(),
      resolveApiKey: () => Promise.resolve('cursor-key'),
    },
    agentRuntime: {
      runtimeSettings: {},
      toolSettingsByName: options.toolSettingsByName ?? new Map(),
    },
    input: {},
    db: {},
    toolDefs: [],
    allParts: [],
    fullText: '',
    checkpointWriter: {
      checkpoint: () => Promise.resolve(false),
    },
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

  it('scopes the tool-call event name to the provider type', async () => {
    await mockMessageRepository();
    const { runLegacyTextStream } = await import(
      '../../../../src/modules/generation/application/stream-text-turn-stages'
    );
    const session = createSession([
      { type: 'tool_call', toolCallId: 'tool-1', name: 'search', done: false },
      { type: 'text', text: '', done: true },
    ]);
    session.provider = {
      ...session.provider,
      providerType: 'openai',
    } as unknown as StreamTextTurnSession['provider'];

    const events = [];
    for await (const event of runLegacyTextStream(session)) events.push(event);

    expect(events).toContainEqual({
      type: 'system_event',
      event: 'openai_internal_tool_call',
      detail: 'search',
    });
  });

  it('passes the resolved tool allowlist and settings to legacy providers', async () => {
    await mockMessageRepository();
    const { runLegacyTextStream } = await import(
      '../../../../src/modules/generation/application/stream-text-turn-stages'
    );
    let capturedRequest: TextGenerationRequest | undefined;
    const toolSettingsByName = new Map([
      ['bash', { enabled: true, parameters: { timeoutSeconds: 5, maxOutputBytes: 12_000 } }],
    ]);
    const session = createSession([{ type: 'text', text: '', done: true }], {
      onRequest: (req) => {
        capturedRequest = req;
      },
      toolSettingsByName,
    });
    session.toolDefs = [
      {
        name: 'bash',
        description: 'Run Bash',
        parameters: { type: 'object' },
      },
    ];

    for await (const _event of runLegacyTextStream(session)) {
      // consume
    }

    expect(capturedRequest?.generationConfig?.tools).toEqual(session.toolDefs);
    expect(capturedRequest?.generationConfig?.toolSettings?.bash).toEqual({
      enabled: true,
      parameters: { timeoutSeconds: 5, maxOutputBytes: 12_000 },
    });
  });

  it('forwards workdir and workdirPolicy to legacy text stream requests', async () => {
    await mockMessageRepository();
    const { runLegacyTextStream } = await import(
      '../../../../src/modules/generation/application/stream-text-turn-stages'
    );
    let capturedRequest: TextGenerationRequest | undefined;
    const session = createSession([{ type: 'text', text: '', done: true }], {
      onRequest: (req) => {
        capturedRequest = req;
      },
    });
    session.workdir = '/srv/chat-workdir';
    session.workdirPolicy = { root: '/srv/chat-workdir', restricted: true };

    for await (const _event of runLegacyTextStream(session)) {
      // consume
    }

    expect(capturedRequest?.workdir).toBe('/srv/chat-workdir');
    expect(capturedRequest?.workdirPolicy).toEqual({
      root: '/srv/chat-workdir',
      restricted: true,
    });
  });
});
