import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import type { AgentTurnRequest } from '../../../src/services/providers/types';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  AgentSettingsError,
  buildRespondStreamRequest,
  makeAgentProfile,
  mockDbWithFullCapture,
  mockNoopTools,
  mockPassThroughDb,
  mockProviderRegistry,
  mockVerifiedChatOwnership,
  parsePersistedRecord,
  parseSseEvents,
  restoreAllMocks,
} from './_respond-stream-helpers';

let TEST_USER!: UserFixture;

beforeAll(async () => {
  TEST_USER = await insertTestUser();
});

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await restoreAllMocks();
});

describe('POST /respond/stream — agent resolution', () => {
  it('defaults to the Default agent when no agentId is given', async () => {
    const requestedAgentIds: string[] = [];
    await mockVerifiedChatOwnership();
    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, agentId: string) => {
        requestedAgentIds.push(agentId);
        return Promise.resolve({ id: 'default' });
      },
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({ chatId: 'chat-1', prompt: 'Hello' })
    );

    expect(requestedAgentIds).toEqual(['default']);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
  });

  it('returns 404 for an unknown agent before SSE starts', async () => {
    await mockVerifiedChatOwnership();
    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: () =>
        Promise.reject(new AgentSettingsError('Agent not found.', 404, 'NOT_FOUND')),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'chat-1',
        prompt: 'Hello',
        agentId: 'user:missing-agent',
      })
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Agent not found');
  });

  it('sends the selected agent system prompt to the provider', async () => {
    let capturedSystemPrompt: string | undefined;
    let capturedPrompt: string | undefined;
    let capturedToolCount = -1;

    await mockVerifiedChatOwnership();
    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: () =>
        Promise.resolve(
          makeAgentProfile({
            id: 'user:runtime-agent',
            name: 'Runtime Agent',
            kind: 'user',
            role: 'primary',
            source: { type: 'markdown', path: '/tmp/runtime-agent.md' },
            systemPrompt: 'Use the runtime agent system prompt.',
          })
        ),
    }));
    await mockProviderRegistry(async function* streamAgentTurn(req: AgentTurnRequest) {
      await Promise.resolve();
      capturedSystemPrompt = req.systemPrompt;
      capturedPrompt = req.prompt;
      capturedToolCount = req.toolDefinitions?.length ?? 0;
      yield { type: 'assistant_text_delta', text: 'Agent response' };
      yield { type: 'turn_completed', providerState: null };
    });
    await mock.module('../../../src/db/database', mockPassThroughDb(TEST_USER.id));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'chat-1',
        prompt: 'Hello',
        model: 'test-model',
        systemPrompt: 'Frontend system prompt must be ignored.',
        agentId: 'user:runtime-agent',
        promptSettings: {
          textSystemPrompt: 'Legacy settings prompt must be ignored.',
          imageSystemPrompt: '',
          agentsMd: {
            id: 'agentsMd',
            label: 'AGENTS.md',
            path: '~/.mango/AGENTS.md',
            enabled: true,
            injectionRole: 'system',
            sendFrequency: 'every-turn',
          },
          claudeMd: {
            id: 'claudeMd',
            label: 'CLAUDE.md',
            path: '~/.claude/CLAUDE.md',
            enabled: true,
            injectionRole: 'system',
            sendFrequency: 'every-turn',
          },
          customRules: [],
        },
      })
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(capturedSystemPrompt).toBe('Use the runtime agent system prompt.');
    expect(capturedPrompt).toBe('Hello');
    expect(capturedToolCount).toBe(0);
  });

  it('does not persist stateless-loop providerState to the database', async () => {
    const dbMock = mockDbWithFullCapture(TEST_USER.id);

    const STATELESS_LOOP_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'test-model',
      systemPromptHash: 'none',
      toolsetHash: 'abc123',
      loopMessages: [{ role: 'user', content: 'Hello' }],
    });

    await mockVerifiedChatOwnership();

    await mockProviderRegistry(async function* streamStatelessLoop() {
      await Promise.resolve();
      yield { type: 'assistant_text_delta', text: 'Hi' };
      yield { type: 'turn_completed', providerState: STATELESS_LOOP_STATE };
    });

    await mockNoopTools();

    await mock.module('../../../src/db/database', dbMock.moduleFactory);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({ chatId: 'test-chat', prompt: 'Hello', model: 'test-model' })
    );

    const rawText = await response.text();
    const sseEvents = parseSseEvents(rawText);

    const aiMessage = dbMock.insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    expect(aiMessage?.providerState).toBeNull();

    const durableUpdate = dbMock.chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState !== null
    );
    expect(durableUpdate).toBeUndefined();

    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toMatchObject({ type: 'context_info', mode: 'replay' });
    expect(typeof contextInfo?.estimatedInputTokens).toBe('number');

    const contextUpdate = dbMock.chatSetCalls.find((u) => typeof u.lastContextState === 'string');
    expect(contextUpdate?.lastProviderState).toBeNull();

    const persistedContext = parsePersistedRecord(contextUpdate?.lastContextState);
    expect(persistedContext).toMatchObject({ mode: 'replay', severity: 'normal' });
    expect(typeof persistedContext.estimatedInputTokens).toBe('number');
  });

  it('uses selected agent runtime settings when request fields are absent', async () => {
    let capturedConfig: AgentTurnRequest['generationConfig'];

    await mockVerifiedChatOwnership();

    await mock.module(
      '../../../src/modules/provider-settings/infrastructure/provider-settings-repository',
      () => ({
        getProviderSettings: () =>
          Promise.resolve({
            provider: 'deepseek',
            thinkingEnabled: true,
            reasoningEffort: 'max',
            maxToolIterations: 3,
          }),
      })
    );
    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: () =>
        Promise.resolve(
          makeAgentProfile({
            id: 'default',
            systemPrompt: 'Chat runtime prompt.',
            thinkingEnabled: true,
            reasoningEffort: 'max',
            maxToolIterations: 3,
          })
        ),
    }));

    await mockProviderRegistry(
      async function* streamWithRuntimeSettings(req: AgentTurnRequest) {
        await Promise.resolve();
        capturedConfig = req.generationConfig;
        yield { type: 'assistant_text_delta', text: 'Hi' };
        yield { type: 'turn_completed', providerState: null };
      },
      { providerType: 'deepseek' }
    );

    await mockNoopTools();

    await mock.module('../../../src/db/database', mockPassThroughDb(TEST_USER.id));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({ chatId: 'test-chat', prompt: 'Hello', model: 'deepseek-chat' })
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(capturedConfig).toMatchObject({
      thinkingEnabled: true,
      reasoningEffort: 'max',
      maxToolIterations: 3,
    });
  });

  it('lets agent runtime settings override request settings for one turn', async () => {
    let capturedConfig: AgentTurnRequest['generationConfig'];

    await mockVerifiedChatOwnership();

    await mock.module(
      '../../../src/modules/provider-settings/infrastructure/provider-settings-repository',
      () => ({
        getProviderSettings: () =>
          Promise.resolve({
            provider: 'deepseek',
            thinkingEnabled: true,
            reasoningEffort: 'max',
            maxToolIterations: 7,
          }),
      })
    );
    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: () =>
        Promise.resolve(
          makeAgentProfile({
            id: 'default',
            systemPrompt: 'Chat runtime prompt.',
            thinkingEnabled: true,
            reasoningEffort: 'max',
            maxToolIterations: 4,
          })
        ),
    }));

    await mockProviderRegistry(
      async function* streamWithAgentOverrides(req: AgentTurnRequest) {
        await Promise.resolve();
        capturedConfig = req.generationConfig;
        yield { type: 'assistant_text_delta', text: 'Hi' };
        yield { type: 'turn_completed', providerState: null };
      },
      { providerType: 'deepseek' }
    );

    await mockNoopTools();

    await mock.module('../../../src/db/database', mockPassThroughDb(TEST_USER.id));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({
        chatId: 'test-chat',
        prompt: 'Hello',
        model: 'deepseek-chat',
        thinkingEnabled: false,
        reasoningEffort: 'high',
        maxToolIterations: 2,
      })
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(capturedConfig).toMatchObject({
      thinkingEnabled: true,
      reasoningEffort: 'max',
      maxToolIterations: 4,
    });
  });
});
