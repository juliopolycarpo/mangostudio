import { describe, expect, it, mock, afterEach } from 'bun:test';
import type { AgentProfile } from '@mangostudio/shared/agents';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { getDb } from '../../../src/db/database';
import {
  verifyChatOwnership,
  listByUserId,
  getById,
  createChat,
  updateChat,
  deleteChat,
} from '../../../src/modules/chats/infrastructure/chat-repository';
import {
  getProviderForModel,
  getProvider,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import {
  getAllToolDefinitions,
  getToolDefinitionsForAgent,
  executeTool,
  getTool,
  getSafeEffectiveToolSettings,
} from '../../../src/services/tools';
import { clearSubagentCache } from '../../../src/modules/generation/application/subagent-response-cache';
import * as realGeminiNs from '../../../src/services/gemini';
import * as realProviderSettingsRepoNs from '../../../src/modules/provider-settings/infrastructure/provider-settings-repository';
import * as realToolSettingsRepoNs from '../../../src/modules/tool-settings/infrastructure/tool-settings-repository';
import { getAgentProfile } from '../../../src/modules/agents/application/agent-settings-service';
import { AgentSettingsError } from '../../../src/modules/agents/domain/agent-profile';
import type { AgentTurnRequest } from '../../../src/services/providers/types';
import { getAppSettings } from '../../../src/modules/app-settings/application/app-settings-service';
import {
  runSubagentTurn,
  SubagentDelegationError,
} from '../../../src/modules/generation/application/subagent-runner';

const TEST_USER = {
  id: 'test-user-stream',
  name: 'Stream User',
  email: 'stream@mangostudio.test',
};

// Snapshot real implementations as plain values at module-load time, before any
// test can call mock.module(). Bun's mock.module() updates live namespace bindings,
// so spreading a namespace object in afterEach would spread the already-mocked values.
// Capturing individual named exports as constants avoids that trap.
const realGetDb = getDb;
const realVerifyChatOwnership = verifyChatOwnership;
const realListByUserId = listByUserId;
const realGetById = getById;
const realCreateChat = createChat;
const realUpdateChat = updateChat;
const realDeleteChat = deleteChat;
const realGetProviderForModel = getProviderForModel;
const realGetProvider = getProvider;
const realRegisterProvider = registerProvider;
const realGetAllToolDefinitions = getAllToolDefinitions;
const realGetToolDefinitionsForAgent = getToolDefinitionsForAgent;
const realExecuteTool = executeTool;
const realGetTool = getTool;
const realGetSafeEffectiveToolSettings = getSafeEffectiveToolSettings;
const realGetAgentProfile = getAgentProfile;
const realGetAppSettings = getAppSettings;
const realRunSubagentTurn = runSubagentTurn;
const realSubagentDelegationError = SubagentDelegationError;
// For the gemini barrel we snapshot the whole object immediately.
const realGemini = { ...realGeminiNs };
const realProviderSettingsRepo = { ...realProviderSettingsRepoNs };
const realToolSettingsRepo = { ...realToolSettingsRepoNs };

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  clearSubagentCache();
  // Restore all mocked modules to prevent leakage into later test files.
  // Bun's mock.restore() does NOT revert mock.module() overrides; explicit
  // re-registration with the original values is required.
  await mock.module('../../../src/db/database', () => ({ getDb: realGetDb }));
  await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
    verifyChatOwnership: realVerifyChatOwnership,
    listByUserId: realListByUserId,
    getById: realGetById,
    createChat: realCreateChat,
    updateChat: realUpdateChat,
    deleteChat: realDeleteChat,
  }));
  await mock.module('../../../src/services/providers/core/provider-registry', () => ({
    getProviderForModel: realGetProviderForModel,
    getProvider: realGetProvider,
    registerProvider: realRegisterProvider,
  }));
  await mock.module('../../../src/services/tools', () => ({
    getAllToolDefinitions: realGetAllToolDefinitions,
    getToolDefinitionsForAgent: realGetToolDefinitionsForAgent,
    executeTool: realExecuteTool,
    getTool: realGetTool,
    getSafeEffectiveToolSettings: realGetSafeEffectiveToolSettings,
  }));
  await mock.module('../../../src/modules/app-settings/application/app-settings-service', () => ({
    getAppSettings: realGetAppSettings,
  }));
  await mock.module('../../../src/services/gemini', () => realGemini);
  await mock.module(
    '../../../src/modules/provider-settings/infrastructure/provider-settings-repository',
    () => realProviderSettingsRepo
  );
  await mock.module(
    '../../../src/modules/tool-settings/infrastructure/tool-settings-repository',
    () => realToolSettingsRepo
  );
  await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
    getAgentProfile: realGetAgentProfile,
  }));
  await mock.module('../../../src/modules/generation/application/subagent-runner', () => ({
    runSubagentTurn: realRunSubagentTurn,
    SubagentDelegationError: realSubagentDelegationError,
  }));
});

/**
 * Creates a fully chainable Kysely-mock using a Proxy.
 * - executeTakeFirst() → firstValue  (ownership checks, single-row lookups)
 * - execute()          → []          (list queries like loadHistory)
 */
function makeChain(firstValue: unknown): Record<string, unknown> {
  const terminal = {
    execute: () => Promise.resolve([]),
    executeTakeFirst: () => Promise.resolve(firstValue),
  };
  const proxy: Record<string, unknown> = new Proxy(terminal, {
    get(target, prop) {
      if (prop in target) return (target as Record<string, unknown>)[prop as string];
      return () => proxy;
    },
  });
  return proxy;
}

function parseSseEvents(rawText: string): Array<Record<string, unknown>> {
  return rawText
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => {
      try {
        return JSON.parse(block.replace(/^data: /, '')) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((event): event is Record<string, unknown> => event !== null);
}

function parsePersistedParts(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as Array<Record<string, unknown>>;
}

function parsePersistedRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function makeAgentProfile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'default',
    name: 'Default',
    description: '',
    kind: 'builtin',
    role: 'both',
    source: { type: 'builtin' },
    systemPrompt: 'Default agent prompt.',
    toolNames: [],
    toolsEnabled: false,
    subagentIds: [],
    metadata: {},
    ...overrides,
  };
}

describe('POST /respond/stream', () => {
  it('returns 404 when chat is not found', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(false),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'nonexistent-chat', prompt: 'Hello' }),
      })
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body).toHaveProperty('error');
  });

  it('accepts thinkingVisibility in request body without error', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(false),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'nonexistent-chat',
          prompt: 'Hello',
          thinkingVisibility: 'summary',
        }),
      })
    );

    // Should reach the chat ownership check (404), not a schema validation error (422)
    expect(response.status).toBe(404);
  });

  it('accepts thinkingEnabled and reasoningEffort in request body', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(false),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'nonexistent-chat',
          prompt: 'Hello',
          thinkingEnabled: true,
          reasoningEffort: 'high',
        }),
      })
    );

    // Should reach the chat ownership check (404), not a schema validation error (422)
    expect(response.status).toBe(404);
  });

  it('accepts legacy requests without thinkingVisibility', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(false),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'nonexistent-chat', prompt: 'Hello' }),
      })
    );

    // Should reach the chat ownership check (404), not a schema validation error
    expect(response.status).toBe(404);
  });

  it('resolves Chat agent metadata when agentMode is chat without agentId', async () => {
    const requestedAgentIds: string[] = [];
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));
    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, agentId: string) => {
        requestedAgentIds.push(agentId);
        return Promise.resolve({ id: 'chat' });
      },
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'chat-1', prompt: 'Hello', agentMode: 'chat' }),
      })
    );

    expect(requestedAgentIds).toEqual(['chat']);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
  });

  it('defaults Agent mode to the Default agent', async () => {
    const requestedAgentIds: string[] = [];
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));
    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, agentId: string) => {
        requestedAgentIds.push(agentId);
        return Promise.resolve({ id: 'default' });
      },
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'chat-1', prompt: 'Hello', agentMode: 'agent' }),
      })
    );

    expect(requestedAgentIds).toEqual(['default']);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
  });

  it('returns 404 for an unknown agent before SSE starts', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));
    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: () =>
        Promise.reject(new AgentSettingsError('Agent not found.', 404, 'NOT_FOUND')),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'chat-1',
          prompt: 'Hello',
          agentMode: 'agent',
          agentId: 'user:missing-agent',
        }),
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

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));
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
    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            capturedSystemPrompt = req.systemPrompt;
            capturedPrompt = req.prompt;
            capturedToolCount = req.toolDefinitions?.length ?? 0;
            yield { type: 'assistant_text_delta', text: 'Agent response' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));
    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [{ name: 'noop', description: 'no-op', parameters: {} }],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({ ok: true }),
    }));
    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'chat-1',
          prompt: 'Hello',
          model: 'test-model',
          systemPrompt: 'Frontend system prompt must be ignored.',
          agentMode: 'agent',
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
        }),
      })
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(capturedSystemPrompt).toBe('Use the runtime agent system prompt.');
    expect(capturedPrompt).toBe('Hello');
    expect(capturedToolCount).toBe(0);
  });

  it('does not persist stateless-loop providerState to the database', async () => {
    const chatSetCalls: Array<Record<string, unknown>> = [];
    const insertedMessages: Array<Record<string, unknown>> = [];

    const STATELESS_LOOP_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'test-model',
      systemPromptHash: 'none',
      toolsetHash: 'abc123',
      loopMessages: [{ role: 'user', content: 'Hello' }],
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            yield { type: 'assistant_text_delta', text: 'Hi' };
            yield { type: 'turn_completed', providerState: STATELESS_LOOP_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: (_table: string) => ({
          values: (values: Record<string, unknown>) => {
            if (_table === 'messages') insertedMessages.push({ ...values });
            return { execute: () => Promise.resolve() };
          },
        }),
        updateTable: () => ({
          set: (values: Record<string, unknown>) => {
            chatSetCalls.push({ ...values });
            return makeChain(undefined);
          },
        }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hello', model: 'test-model' }),
      })
    );

    const rawText = await response.text();

    const sseEvents = parseSseEvents(rawText);

    // The AI message row must have providerState = null (not the stateless-loop state)
    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    expect(aiMessage?.providerState).toBeNull();

    // chats.lastProviderState must never be set to a non-null value
    const durableUpdate = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState !== null
    );
    expect(durableUpdate).toBeUndefined();

    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toMatchObject({ type: 'context_info', mode: 'replay' });
    expect(typeof contextInfo?.estimatedInputTokens).toBe('number');

    const contextUpdate = chatSetCalls.find((u) => typeof u.lastContextState === 'string');
    expect(contextUpdate?.lastProviderState).toBeNull();

    const persistedContext = parsePersistedRecord(contextUpdate?.lastContextState);
    expect(persistedContext).toMatchObject({ mode: 'replay', severity: 'normal' });
    expect(typeof persistedContext.estimatedInputTokens).toBe('number');
  });

  it('uses selected agent runtime settings when request fields are absent', async () => {
    let capturedConfig: AgentTurnRequest['generationConfig'];

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

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
            id: 'chat',
            systemPrompt: 'Chat runtime prompt.',
            thinkingEnabled: true,
            reasoningEffort: 'max',
            maxToolIterations: 3,
          })
        ),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'deepseek',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            capturedConfig = req.generationConfig;
            yield { type: 'assistant_text_delta', text: 'Hi' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hello', model: 'deepseek-chat' }),
      })
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

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

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
            id: 'chat',
            systemPrompt: 'Chat runtime prompt.',
            thinkingEnabled: true,
            reasoningEffort: 'max',
            maxToolIterations: 4,
          })
        ),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'deepseek',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            capturedConfig = req.generationConfig;
            yield { type: 'assistant_text_delta', text: 'Hi' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Hello',
          model: 'deepseek-chat',
          thinkingEnabled: false,
          reasoningEffort: 'high',
          maxToolIterations: 2,
        }),
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

  it('streams subagent lifecycle events and persists a delegation trace', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    const parentToolResults: string[] = [];

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, agentId: string) =>
        Promise.resolve(
          agentId === 'user:explorer'
            ? makeAgentProfile({
                id: 'user:explorer',
                name: 'Explore',
                role: 'subagent',
                systemPrompt: 'Explore the codebase.',
                toolNames: [],
                toolsEnabled: false,
              })
            : makeAgentProfile({
                id: 'default',
                name: 'Default',
                role: 'both',
                systemPrompt: 'Delegate exploration when useful.',
                toolNames: ['delegate_to_agent'],
                toolsEnabled: true,
                subagentIds: ['user:explorer'],
              })
        ),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (req.agentId === 'user:explorer') {
              yield { type: 'assistant_text_delta', text: 'Found the relevant files.' };
              yield { type: 'turn_completed', providerState: null };
              return;
            }

            if (!req.toolResults) {
              yield {
                type: 'tool_call_started',
                callId: 'delegate-1',
                name: 'delegate_to_agent',
              };
              yield {
                type: 'tool_call_completed',
                callId: 'delegate-1',
                name: 'delegate_to_agent',
                arguments: JSON.stringify({
                  agentId: 'user:explorer',
                  task: 'Find the relevant files for this feature.',
                  expectedOutput: 'Concise file summary.',
                }),
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }

            parentToolResults.push(req.toolResults[0]?.result ?? '');
            yield { type: 'assistant_text_delta', text: 'Used Explore.' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: (_table: string) => ({
          values: (values: Record<string, unknown>) => {
            if (_table === 'messages') insertedMessages.push({ ...values });
            return { execute: () => Promise.resolve() };
          },
        }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Use an explorer.',
          model: 'test-model',
          agentMode: 'agent',
          agentId: 'default',
        }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    expect(sseEvents.map((event) => event.type)).toContain('subagent_started');
    expect(sseEvents.map((event) => event.type)).toContain('subagent_text');
    expect(sseEvents.map((event) => event.type)).toContain('subagent_completed');
    expect(parentToolResults[0]).toContain('Found the relevant files.');

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    expect(parts.find((part) => part.type === 'subagent_trace')).toMatchObject({
      type: 'subagent_trace',
      toolCallId: 'delegate-1',
      agentId: 'user:explorer',
      status: 'completed',
      summary: 'Found the relevant files.',
    });
  });

  it('forces a summarize follow-up turn when the subagent runs tools but never streams text', async () => {
    const parentToolResults: string[] = [];
    let summarizeTurnCount = 0;

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, agentId: string) =>
        Promise.resolve(
          agentId === 'user:explorer'
            ? makeAgentProfile({
                id: 'user:explorer',
                name: 'Explore',
                role: 'subagent',
                systemPrompt: 'Explore the codebase.',
                toolNames: ['noop'],
                toolsEnabled: true,
              })
            : makeAgentProfile({
                id: 'default',
                name: 'Default',
                role: 'both',
                systemPrompt: 'Delegate exploration when useful.',
                toolNames: ['delegate_to_agent'],
                toolsEnabled: true,
                subagentIds: ['user:explorer'],
              })
        ),
    }));

    await mock.module('../../../src/services/tools', () => {
      const noopTool = {
        definition: { name: 'noop', description: 'no-op', parameters: {} },
        settings: {
          title: 'Noop',
          description: 'No-op tool',
          category: 'system',
          enabledByDefault: true,
          canDisable: true,
          defaultParameters: {},
          parameterDescriptors: [],
        },
        execute: (_args: Record<string, unknown>, _context: Record<string, unknown>) =>
          Promise.resolve({ ok: true }),
      };

      const delegateTool = {
        definition: { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
        settings: {
          title: 'Delegate',
          description: 'Delegate tool',
          category: 'system',
          enabledByDefault: true,
          canDisable: true,
          defaultParameters: {},
          parameterDescriptors: [],
        },
        execute: (
          _args: Record<string, unknown>,
          context: { delegateToAgent?: (input: unknown) => Promise<unknown> }
        ) => {
          if (!context.delegateToAgent) throw new Error('Delegation unavailable');
          return context.delegateToAgent(_args);
        },
      };

      const toolsByName = new Map([
        ['noop', noopTool],
        ['delegate_to_agent', delegateTool],
      ]);

      return {
        getAllToolDefinitions: () => [noopTool.definition, delegateTool.definition],
        getToolDefinitionsForAgent: (profile: AgentProfile) => {
          if (!profile.toolsEnabled) return [];
          const allowed = new Set(profile.toolNames);
          return Array.from(toolsByName.values())
            .filter((tool) => allowed.has('*') || allowed.has(tool.definition.name))
            .map((tool) => tool.definition);
        },
        getTool: (name: string) => toolsByName.get(name),
        getSafeEffectiveToolSettings: (
          _tool: unknown,
          settings?: { enabled?: boolean; parameters?: Record<string, unknown> }
        ) => ({
          enabled: settings?.enabled ?? true,
          parameters: settings?.parameters ?? {},
        }),
        executeTool: async (
          name: string,
          args: Record<string, unknown>,
          context: { delegateToAgent?: (input: unknown) => Promise<unknown> }
        ) => {
          const tool = toolsByName.get(name);
          if (!tool) throw new Error(`Unknown tool: "${name}"`);
          return tool.execute(args, context);
        },
      };
    });

    await mock.module('../../../src/services/providers/core/provider-registry', () => {
      return {
        getProviderForModel: () =>
          Promise.resolve({
            providerType: 'openai-compatible',
            generateText: () => Promise.resolve({ text: '' }),
            generateAgentTurnStream: async function* (req: AgentTurnRequest) {
              await Promise.resolve();
              if (req.agentId === 'user:explorer') {
                // Summarize follow-up turn: no tool definitions and a prompt set.
                const isSummarizeTurn =
                  (req.toolDefinitions?.length ?? 0) === 0 &&
                  typeof req.prompt === 'string' &&
                  req.prompt.length > 0;
                if (isSummarizeTurn) {
                  summarizeTurnCount += 1;
                  yield { type: 'assistant_text_delta', text: 'I explored the files.' };
                  yield { type: 'turn_completed', providerState: null };
                  return;
                }

                if (!req.toolResults) {
                  yield { type: 'tool_call_started', callId: 'noop-1', name: 'noop' };
                  yield {
                    type: 'tool_call_completed',
                    callId: 'noop-1',
                    name: 'noop',
                    arguments: '{}',
                  };
                  yield { type: 'tool_call_started', callId: 'noop-2', name: 'noop' };
                  yield {
                    type: 'tool_call_completed',
                    callId: 'noop-2',
                    name: 'noop',
                    arguments: '{}',
                  };
                  yield { type: 'turn_completed', providerState: null };
                  return;
                }

                // Tool results received, but model has nothing more to say.
                yield { type: 'turn_completed', providerState: null };
                return;
              }

              if (!req.toolResults) {
                yield {
                  type: 'tool_call_started',
                  callId: 'delegate-1',
                  name: 'delegate_to_agent',
                };
                yield {
                  type: 'tool_call_completed',
                  callId: 'delegate-1',
                  name: 'delegate_to_agent',
                  arguments: JSON.stringify({
                    agentId: 'user:explorer',
                    task: 'Run tools without producing text.',
                  }),
                };
                yield { type: 'turn_completed', providerState: null };
                return;
              }

              parentToolResults.push(req.toolResults[0]?.result ?? '');
              yield { type: 'assistant_text_delta', text: 'OK' };
              yield { type: 'turn_completed', providerState: null };
            },
          }),
      };
    });

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Use an explorer.',
          model: 'test-model',
          agentMode: 'agent',
          agentId: 'default',
        }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());
    expect(sseEvents.map((event) => event.type)).toContain('subagent_text');
    expect(parentToolResults[0]).toContain('I explored the files.');
    expect(summarizeTurnCount).toBe(1);
  });

  it('retries once and falls back when the delegation response is missing or invalid', async () => {
    const parentToolResults: string[] = [];
    let callCount = 0;

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, agentId: string) =>
        Promise.resolve(
          agentId === 'user:explorer'
            ? makeAgentProfile({
                id: 'user:explorer',
                name: 'Explore',
                role: 'subagent',
                systemPrompt: 'Explore the codebase.',
                toolNames: [],
                toolsEnabled: false,
              })
            : makeAgentProfile({
                id: 'default',
                name: 'Default',
                role: 'both',
                systemPrompt: 'Delegate exploration when useful.',
                toolNames: ['delegate_to_agent'],
                toolsEnabled: true,
                subagentIds: ['user:explorer'],
              })
        ),
    }));

    await mock.module('../../../src/modules/generation/application/subagent-runner', () => ({
      runSubagentTurn: () => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve({});
        return Promise.resolve({
          agentId: 'user:explorer',
          agentName: 'Explore',
          status: 'completed',
          summary: 'Recovered response.',
          messages: [{ role: 'assistant', text: 'Recovered response.' }],
          toolCallCount: 0,
          tools: [],
          durationMs: 1,
          trace: {
            type: 'subagent_trace',
            toolCallId: '',
            agentId: 'user:explorer',
            agentName: 'Explore',
            status: 'completed',
            summary: 'Recovered response.',
            toolCallCount: 0,
            lastMessage: 'Recovered response.',
            messages: [{ role: 'assistant', text: 'Recovered response.' }],
            tools: [],
          },
        });
      },
      SubagentDelegationError: class SubagentDelegationError extends Error {
        constructor(
          message: string,
          readonly code: string
        ) {
          super(message);
          this.name = 'SubagentDelegationError';
        }
      },
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [
        { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
      ],
      getToolDefinitionsForAgent: () => [
        { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
      ],
      getTool: () => ({
        definition: { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
        settings: {
          title: 'Delegate',
          description: 'Delegate tool',
          category: 'system',
          enabledByDefault: true,
          canDisable: true,
          defaultParameters: {},
          parameterDescriptors: [],
        },
        execute: () => Promise.resolve({}),
      }),
      getSafeEffectiveToolSettings: () => ({ enabled: true, parameters: {} }),
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (!req.toolResults) {
              yield { type: 'tool_call_started', callId: 'delegate-1', name: 'delegate_to_agent' };
              yield {
                type: 'tool_call_completed',
                callId: 'delegate-1',
                name: 'delegate_to_agent',
                arguments: JSON.stringify({ agentId: 'user:explorer', task: 'Test retry.' }),
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }

            parentToolResults.push(req.toolResults[0]?.result ?? '');
            yield { type: 'assistant_text_delta', text: 'OK' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Use an explorer.',
          model: 'test-model',
          agentMode: 'agent',
          agentId: 'default',
        }),
      })
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(parentToolResults[0]).toContain('Recovered response.');
    expect(callCount).toBe(2);
  });

  it('recovers a delegation response from cache when the subagent streamed text but returned an invalid result', async () => {
    const parentToolResults: string[] = [];
    let callCount = 0;

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/modules/app-settings/application/app-settings-service', () => ({
      getAppSettings: () =>
        Promise.resolve({
          multiAgentSettings: {
            enabled: true,
            chatDelegationEnabled: true,
            traceVisibility: 'full',
            maxDepth: 2,
            maxSubagentCalls: 5,
            timeoutMs: 5_000,
            defaultMaxTurns: 2,
          },
        }),
    }));

    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, agentId: string) =>
        Promise.resolve(
          agentId === 'user:explorer'
            ? makeAgentProfile({
                id: 'user:explorer',
                name: 'Explore',
                role: 'subagent',
                systemPrompt: 'Explore the codebase.',
                toolNames: [],
                toolsEnabled: false,
              })
            : makeAgentProfile({
                id: 'default',
                name: 'Default',
                role: 'both',
                systemPrompt: 'Delegate exploration when useful.',
                toolNames: ['delegate_to_agent'],
                toolsEnabled: true,
                subagentIds: ['user:explorer'],
              })
        ),
    }));

    await mock.module('../../../src/modules/generation/application/subagent-runner', () => ({
      runSubagentTurn: (input: {
        request: { task: string };
        onEvent?: (event: unknown) => void;
      }) => {
        callCount += 1;
        input.onEvent?.({
          type: 'started',
          agentId: 'user:explorer',
          agentName: 'Explore',
          task: input.request.task,
        });
        input.onEvent?.({ type: 'text', agentId: 'user:explorer', text: 'Recovered via stream.' });
        input.onEvent?.({
          type: 'completed',
          agentId: 'user:explorer',
          agentName: 'Explore',
          summary: 'Recovered via stream.',
          toolCallCount: 0,
        });
        return Promise.resolve({});
      },
      SubagentDelegationError: class SubagentDelegationError extends Error {
        constructor(
          message: string,
          readonly code: string
        ) {
          super(message);
          this.name = 'SubagentDelegationError';
        }
      },
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [
        { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
      ],
      getToolDefinitionsForAgent: () => [
        { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
      ],
      getTool: () => ({
        definition: { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
        settings: {
          title: 'Delegate',
          description: 'Delegate tool',
          category: 'system',
          enabledByDefault: true,
          canDisable: true,
          defaultParameters: {},
          parameterDescriptors: [],
        },
        execute: () => Promise.resolve({}),
      }),
      getSafeEffectiveToolSettings: () => ({ enabled: true, parameters: {} }),
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (!req.toolResults) {
              yield { type: 'tool_call_started', callId: 'delegate-1', name: 'delegate_to_agent' };
              yield {
                type: 'tool_call_completed',
                callId: 'delegate-1',
                name: 'delegate_to_agent',
                arguments: JSON.stringify({ agentId: 'user:explorer', task: 'Stream then drop.' }),
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }

            parentToolResults.push(req.toolResults[0]?.result ?? '');
            yield { type: 'assistant_text_delta', text: 'OK' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Use an explorer.',
          model: 'test-model',
          agentMode: 'agent',
          agentId: 'default',
        }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());
    expect(sseEvents.map((event) => event.type)).toContain('subagent_text');
    expect(parentToolResults[0]).toContain('Recovered via stream.');
    expect(callCount).toBe(1);
  });

  it('retries up to 3 times then returns a structured fallback when a subagent produces no output', async () => {
    const parentToolResults: string[] = [];
    let callCount = 0;

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/modules/app-settings/application/app-settings-service', () => ({
      getAppSettings: () =>
        Promise.resolve({
          multiAgentSettings: {
            enabled: true,
            chatDelegationEnabled: true,
            traceVisibility: 'full',
            maxDepth: 2,
            maxSubagentCalls: 5,
            timeoutMs: 5_000,
            defaultMaxTurns: 2,
          },
        }),
    }));

    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, agentId: string) =>
        Promise.resolve(
          agentId === 'user:explorer'
            ? makeAgentProfile({
                id: 'user:explorer',
                name: 'Explore',
                role: 'subagent',
                systemPrompt: 'Explore the codebase.',
                toolNames: [],
                toolsEnabled: false,
              })
            : makeAgentProfile({
                id: 'default',
                name: 'Default',
                role: 'both',
                systemPrompt: 'Delegate exploration when useful.',
                toolNames: ['delegate_to_agent'],
                toolsEnabled: true,
                subagentIds: ['user:explorer'],
              })
        ),
    }));

    await mock.module('../../../src/modules/generation/application/subagent-runner', () => ({
      runSubagentTurn: () => {
        callCount += 1;
        return Promise.resolve({});
      },
      SubagentDelegationError: class SubagentDelegationError extends Error {
        constructor(
          message: string,
          readonly code: string
        ) {
          super(message);
          this.name = 'SubagentDelegationError';
        }
      },
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [
        { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
      ],
      getToolDefinitionsForAgent: () => [
        { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
      ],
      getTool: () => ({
        definition: { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
        settings: {
          title: 'Delegate',
          description: 'Delegate tool',
          category: 'system',
          enabledByDefault: true,
          canDisable: true,
          defaultParameters: {},
          parameterDescriptors: [],
        },
        execute: () => Promise.resolve({}),
      }),
      getSafeEffectiveToolSettings: () => ({ enabled: true, parameters: {} }),
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (!req.toolResults) {
              yield { type: 'tool_call_started', callId: 'delegate-1', name: 'delegate_to_agent' };
              yield {
                type: 'tool_call_completed',
                callId: 'delegate-1',
                name: 'delegate_to_agent',
                arguments: JSON.stringify({ agentId: 'user:explorer', task: 'No output.' }),
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }

            parentToolResults.push(req.toolResults[0]?.result ?? '');
            yield { type: 'assistant_text_delta', text: 'OK' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Use an explorer.',
          model: 'test-model',
          agentMode: 'agent',
          agentId: 'default',
        }),
      })
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(parentToolResults[0]).toContain('Subagent failed to produce a final response.');
    expect(callCount).toBe(4);
  }, 20_000);

  it('forces a timeout fallback when the subagent never resolves', async () => {
    const parentToolResults: string[] = [];
    let callCount = 0;

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/modules/app-settings/application/app-settings-service', () => ({
      getAppSettings: () =>
        Promise.resolve({
          multiAgentSettings: {
            enabled: true,
            chatDelegationEnabled: true,
            traceVisibility: 'full',
            maxDepth: 2,
            maxSubagentCalls: 5,
            timeoutMs: 25,
            defaultMaxTurns: 2,
          },
        }),
    }));

    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, agentId: string) =>
        Promise.resolve(
          agentId === 'user:explorer'
            ? makeAgentProfile({
                id: 'user:explorer',
                name: 'Explore',
                role: 'subagent',
                systemPrompt: 'Explore the codebase.',
                toolNames: [],
                toolsEnabled: false,
              })
            : makeAgentProfile({
                id: 'default',
                name: 'Default',
                role: 'both',
                systemPrompt: 'Delegate exploration when useful.',
                toolNames: ['delegate_to_agent'],
                toolsEnabled: true,
                subagentIds: ['user:explorer'],
              })
        ),
    }));

    await mock.module('../../../src/modules/generation/application/subagent-runner', () => ({
      runSubagentTurn: () => {
        callCount += 1;
        return new Promise(() => undefined);
      },
      SubagentDelegationError: class SubagentDelegationError extends Error {
        constructor(
          message: string,
          readonly code: string
        ) {
          super(message);
          this.name = 'SubagentDelegationError';
        }
      },
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [
        { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
      ],
      getToolDefinitionsForAgent: () => [
        { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
      ],
      getTool: () => ({
        definition: { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
        settings: {
          title: 'Delegate',
          description: 'Delegate tool',
          category: 'system',
          enabledByDefault: true,
          canDisable: true,
          defaultParameters: {},
          parameterDescriptors: [],
        },
        execute: () => Promise.resolve({}),
      }),
      getSafeEffectiveToolSettings: () => ({ enabled: true, parameters: {} }),
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (!req.toolResults) {
              yield { type: 'tool_call_started', callId: 'delegate-1', name: 'delegate_to_agent' };
              yield {
                type: 'tool_call_completed',
                callId: 'delegate-1',
                name: 'delegate_to_agent',
                arguments: JSON.stringify({ agentId: 'user:explorer', task: 'Hang forever.' }),
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }

            parentToolResults.push(req.toolResults[0]?.result ?? '');
            yield { type: 'assistant_text_delta', text: 'OK' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Use an explorer.',
          model: 'test-model',
          agentMode: 'agent',
          agentId: 'default',
        }),
      })
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(parentToolResults[0]).toContain('"status":"timeout"');
    expect(callCount).toBe(1);
  }, 20_000);

  it('runs 1000+ delegation cycles with 0% empty tool results', async () => {
    let delegationIndex = 0;

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/modules/app-settings/application/app-settings-service', () => ({
      getAppSettings: () =>
        Promise.resolve({
          multiAgentSettings: {
            enabled: true,
            chatDelegationEnabled: true,
            traceVisibility: 'off',
            maxDepth: 2,
            maxSubagentCalls: 10,
            timeoutMs: 5_000,
            defaultMaxTurns: 2,
          },
        }),
    }));

    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, agentId: string) =>
        Promise.resolve(
          agentId === 'user:explorer'
            ? makeAgentProfile({
                id: 'user:explorer',
                name: 'Explore',
                role: 'subagent',
                systemPrompt: 'Explore the codebase.',
                toolNames: [],
                toolsEnabled: false,
              })
            : makeAgentProfile({
                id: 'default',
                name: 'Default',
                role: 'both',
                systemPrompt: 'Delegate exploration when useful.',
                toolNames: ['delegate_to_agent'],
                toolsEnabled: true,
                subagentIds: ['user:explorer'],
              })
        ),
    }));

    await mock.module('../../../src/modules/generation/application/subagent-runner', () => ({
      runSubagentTurn: () =>
        Promise.resolve({
          agentId: 'user:explorer',
          agentName: 'Explore',
          status: 'completed',
          summary: 'OK',
          messages: [{ role: 'assistant', text: 'OK' }],
          toolCallCount: 0,
          tools: [],
          durationMs: 1,
          trace: {
            type: 'subagent_trace',
            toolCallId: '',
            agentId: 'user:explorer',
            agentName: 'Explore',
            status: 'completed',
            summary: 'OK',
            toolCallCount: 0,
            lastMessage: 'OK',
            messages: [{ role: 'assistant', text: 'OK' }],
            tools: [],
          },
        }),
      SubagentDelegationError: class SubagentDelegationError extends Error {
        constructor(
          message: string,
          readonly code: string
        ) {
          super(message);
          this.name = 'SubagentDelegationError';
        }
      },
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [
        { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
      ],
      getToolDefinitionsForAgent: () => [
        { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
      ],
      getTool: () => ({
        definition: { name: 'delegate_to_agent', description: 'delegate', parameters: {} },
        settings: {
          title: 'Delegate',
          description: 'Delegate tool',
          category: 'system',
          enabledByDefault: true,
          canDisable: true,
          defaultParameters: {},
          parameterDescriptors: [],
        },
        execute: () => Promise.resolve({}),
      }),
      getSafeEffectiveToolSettings: () => ({ enabled: true, parameters: {} }),
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (!req.toolResults) {
              delegationIndex += 1;
              const callId = `delegate-${delegationIndex}`;
              yield { type: 'tool_call_started', callId, name: 'delegate_to_agent' };
              yield {
                type: 'tool_call_completed',
                callId,
                name: 'delegate_to_agent',
                arguments: JSON.stringify({ agentId: 'user:explorer', task: `Cycle ${callId}` }),
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }

            const raw = req.toolResults[0]?.result ?? '';
            const parsed = JSON.parse(raw) as { summary?: unknown; tools?: unknown };
            if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
              throw new Error(`Empty subagent summary detected: ${raw.slice(0, 200)}`);
            }
            expect(parsed.tools).toBeUndefined();
            yield { type: 'assistant_text_delta', text: 'OK' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    for (let i = 0; i < 1000; i++) {
      const response = await app.handle(
        new Request('http://localhost/respond/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: 'test-chat',
            prompt: `Cycle ${i}`,
            model: 'test-model',
            agentMode: 'agent',
            agentId: 'default',
          }),
        })
      );
      expect(response.status).toBe(200);
      await response.text();
    }
  }, 60_000);

  it('returns 503 when model catalog is not configured', async () => {
    // Mock getGeminiModelCatalog to return unconfigured state
    await mock.module('../../../src/services/gemini/catalog', () => ({
      getGeminiModelCatalog: () =>
        Promise.resolve({
          configured: false,
          status: 'idle',
          allModels: [],
          textModels: [],
          imageModels: [],
          discoveredTextModels: [],
          discoveredImageModels: [],
        }),
      clearGeminiModelCatalog: () => undefined as void,
    }));

    await mock.module('../../../src/services/gemini', () => ({
      getGeminiModelCatalog: () =>
        Promise.resolve({
          configured: false,
          status: 'idle',
          allModels: [],
          textModels: [],
          imageModels: [],
          discoveredTextModels: [],
          discoveredImageModels: [],
        }),
      getDefaultTextModel: () => null,
      hasTextModel: () => false,
      clearGeminiModelCatalog: () => undefined as void,
    }));

    // Mock DB to return a valid chat owned by our test user
    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'some-chat', prompt: 'Hello' }),
      })
    );

    expect(response.status).toBe(503);
  });

  it('emits fallback_notice and context_info with mode=replay when provider yields continuation_degraded then turn_completed without cursor', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    // A stateless-loop state has no cursor → mode becomes 'replay' in context_info
    const STATELESS_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      loopMessages: [],
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            yield {
              type: 'continuation_degraded',
              from: 'stateful',
              to: 'replay',
              reason: 'cursor_expired',
              reasonCode: 'cursor_expired',
            };
            yield { type: 'assistant_text_delta', text: 'Hello' };
            yield { type: 'turn_completed', providerState: STATELESS_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: (_table: string) => ({
          values: (values: Record<string, unknown>) => {
            if (_table === 'messages') insertedMessages.push({ ...values });
            return { execute: () => Promise.resolve() };
          },
        }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hi', model: 'deepseek-chat' }),
      })
    );

    expect(response.status).toBe(200);

    const rawText = await response.text();

    // Parse SSE lines
    const sseEvents = parseSseEvents(rawText);

    // Assert fallback_notice is emitted
    const fallbackNotice = sseEvents.find((e) => e.type === 'fallback_notice');
    expect(fallbackNotice).toBeDefined();
    expect(fallbackNotice).toMatchObject({
      type: 'fallback_notice',
      from: 'stateful',
      to: 'replay',
    });

    // Assert continuation_transition SSE event is also emitted (typed, structured)
    const continuationTransition = sseEvents.find((e) => e.type === 'continuation_transition');
    expect(continuationTransition).toBeDefined();
    expect(continuationTransition).toMatchObject({
      type: 'continuation_transition',
      provider: 'openai-compatible',
      fromMode: 'stateful',
      toMode: 'replay',
      reasonCode: 'cursor_expired',
      done: false,
    });

    // Assert context_info is emitted with mode=replay (no cursor in stateless-loop)
    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toBeDefined();
    expect(contextInfo).toMatchObject({ type: 'context_info', mode: 'replay' });

    // Assert the persisted AI message contains a typed continuation_transition part
    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    const transitionPart = parts.find((p) => p.type === 'continuation_transition');
    expect(transitionPart).toBeDefined();
    expect(transitionPart).toMatchObject({
      type: 'continuation_transition',
      provider: 'openai-compatible',
      fromMode: 'stateful',
      toMode: 'replay',
      reasonCode: 'cursor_expired',
      recovered: true,
    });
  });

  it('emits fallback_notice with done:false and context_info with done:false in SSE output', async () => {
    const STATELESS_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      loopMessages: [],
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            yield {
              type: 'continuation_degraded',
              from: 'responses',
              to: 'replay',
              reason: 'cursor_expired',
              reasonCode: 'cursor_expired',
            };
            yield { type: 'assistant_text_delta', text: 'OK' };
            yield { type: 'turn_completed', providerState: STATELESS_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: (_table: string) => ({
          values: () => ({ execute: () => Promise.resolve() }),
        }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hi', model: 'deepseek-chat' }),
      })
    );

    expect(response.status).toBe(200);
    const rawText = await response.text();

    const sseEvents = parseSseEvents(rawText);

    const fallbackNotice = sseEvents.find((e) => e.type === 'fallback_notice');
    expect(fallbackNotice).toBeDefined();
    expect(fallbackNotice?.done).toBe(false);

    const continuationTransition = sseEvents.find((e) => e.type === 'continuation_transition');
    expect(continuationTransition).toBeDefined();
    expect(continuationTransition?.done).toBe(false);

    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toBeDefined();
    expect(contextInfo?.done).toBe(false);
  });

  it('emits context_info with mode=stateful when provider returns a cursor in the envelope', async () => {
    const STATEFUL_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      cursor: 'resp_abc123',
      context: {
        providerReportedInputTokens: 2048,
        lastUpdatedAt: Date.now(),
      },
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            yield { type: 'assistant_text_delta', text: 'OK' };
            yield { type: 'turn_completed', providerState: STATEFUL_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hi', model: 'gpt-4o' }),
      })
    );

    expect(response.status).toBe(200);
    const rawText = await response.text();

    const sseEvents = parseSseEvents(rawText);

    const contextInfo = sseEvents.find((e) => e.type === 'context_info');
    expect(contextInfo).toBeDefined();
    expect(contextInfo).toMatchObject({
      type: 'context_info',
      mode: 'stateful',
      estimatedInputTokens: 2048,
    });
  });

  it('replays only the compacted boundary and newer turns after a chat compaction marker', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            yield {
              type: 'assistant_text_delta',
              text: JSON.stringify(req.history.map((turn) => turn.text)),
            };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    const messageRows = [
      {
        id: 'recent-ai',
        role: 'ai',
        text: 'Latest reply',
        parts: null,
        providerState: null,
        modelName: 'test-model',
      },
      {
        id: 'recent-user',
        role: 'user',
        text: 'Recent follow-up',
        parts: null,
        providerState: null,
        modelName: null,
      },
      {
        id: 'summary-ai',
        role: 'ai',
        text: 'Summary of earlier context',
        parts: JSON.stringify([
          { type: 'system_event', event: 'chat_compacted' },
          { type: 'text', text: 'Summary of earlier context' },
        ]),
        providerState: null,
        modelName: 'test-model',
      },
      {
        id: 'old-ai',
        role: 'ai',
        text: 'Old answer',
        parts: null,
        providerState: null,
        modelName: 'test-model',
      },
      {
        id: 'old-user',
        role: 'user',
        text: 'Old prompt',
        parts: null,
        providerState: null,
        modelName: null,
      },
    ];

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: (table: string) => {
          if (table === 'messages') {
            return {
              select: () => ({
                where: () => ({
                  where: () => ({
                    orderBy: () => ({
                      limit: () => ({
                        where: () => ({ execute: () => Promise.resolve(messageRows) }),
                        execute: () => Promise.resolve(messageRows),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }

          return makeChain({ userId: TEST_USER.id });
        },
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Continue', model: 'test-model' }),
      })
    );

    expect(response.status).toBe(200);
    const rawText = await response.text();
    const sseEvents = parseSseEvents(rawText);
    const textEvent = sseEvents.find((event) => event.type === 'text');
    expect(textEvent?.text).toBe(
      JSON.stringify(['Summary of earlier context', 'Recent follow-up', 'Latest reply'])
    );
  });

  it('emits terminal error when provider errors on tool-result continuation', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    // First iteration emits a tool call that the orchestrator will execute;
    // the second iteration (carrying tool results) fails with a turn_error.
    let iteration = 0;
    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            iteration += 1;
            if (iteration === 1) {
              yield { type: 'tool_call_started', callId: 'c1', name: 'noop' };
              yield { type: 'tool_call_completed', callId: 'c1', name: 'noop', arguments: '{}' };
              yield { type: 'turn_completed', providerState: null };
            } else {
              yield { type: 'turn_error', error: 'tool-result continuation failed' };
            }
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [{ name: 'noop', description: 'no-op', parameters: {} }],
      getToolDefinitionsForAgent: () => [{ name: 'noop', description: 'no-op', parameters: {} }],
      executeTool: () => Promise.resolve({ ok: true }),
    }));

    const chatSetCalls: Array<Record<string, unknown>> = [];
    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: (_table: string) => ({
          values: (values: Record<string, unknown>) => {
            if (_table === 'messages') insertedMessages.push({ ...values });
            return { execute: () => Promise.resolve() };
          },
        }),
        updateTable: () => ({
          set: (values: Record<string, unknown>) => {
            chatSetCalls.push({ ...values });
            return makeChain(undefined);
          },
        }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'use tool', model: 'test-model' }),
      })
    );

    expect(response.status).toBe(200);
    const rawText = await response.text();

    const sseEvents = parseSseEvents(rawText);

    // Must emit a terminal error event and no done event
    const errorEvent = sseEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toBe('tool-result continuation failed');
    const doneEvent = sseEvents.find((e) => e.type === 'done');
    expect(doneEvent).toBeUndefined();

    // The error-path AI message must be persisted (as an ai row for audit)
    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    // Durable cursor must be cleared to prevent stale-state replay on next turn
    const clearedDurable = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState === null
    );
    expect(clearedDurable).toBeDefined();
  });

  it('emits system_event(tool_loop_exhausted) and terminal error when loop ceiling is reached with pending tool calls', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    // Provider always yields a tool_call_completed without turn_completed, forcing
    // the orchestrator to exhaust the iteration ceiling on every call.
    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            yield { type: 'tool_call_started', callId: 'c1', name: 'noop' };
            yield { type: 'tool_call_completed', callId: 'c1', name: 'noop', arguments: '{}' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [{ name: 'noop', description: 'no-op', parameters: {} }],
      getToolDefinitionsForAgent: () => [{ name: 'noop', description: 'no-op', parameters: {} }],
      executeTool: () => Promise.resolve({ ok: true }),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: (_table: string) => ({
          values: (values: Record<string, unknown>) => {
            if (_table === 'messages') insertedMessages.push({ ...values });
            return { execute: () => Promise.resolve() };
          },
        }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'loop forever',
          model: 'test-model',
          maxToolIterations: 2,
        }),
      })
    );

    expect(response.status).toBe(200);
    const rawText = await response.text();

    const sseEvents = parseSseEvents(rawText);

    // Must emit system_event with event=tool_loop_exhausted
    const exhaustedEvent = sseEvents.find(
      (e) => e.type === 'system_event' && e.event === 'tool_loop_exhausted'
    );
    expect(exhaustedEvent).toBeDefined();
    expect(exhaustedEvent?.done).toBe(false);
    expect(typeof exhaustedEvent?.detail).toBe('string');

    // Must emit terminal error event (not done)
    const errorEvent = sseEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.done).toBe(true);

    // Must NOT emit a done event
    const doneEvent = sseEvents.find((e) => e.type === 'done');
    expect(doneEvent).toBeUndefined();

    // Persisted AI message must include the system_event part
    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    const exhaustedPart = parts.find(
      (p) => p.type === 'system_event' && p.event === 'tool_loop_exhausted'
    );
    expect(exhaustedPart).toBeDefined();
  });

  it('degrades from OpenAI cursor to replay on provider switch to Gemini and persists new cursor', async () => {
    const chatSetCalls: Array<Record<string, unknown>> = [];
    const insertedMessages: Array<Record<string, unknown>> = [];

    const OPENAI_ENVELOPE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      cursor: 'resp_abc123',
    });

    const GEMINI_ENVELOPE = JSON.stringify({
      schemaVersion: 1,
      provider: 'gemini',
      mode: 'interactions',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'none',
      toolsetHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      cursor: 'interaction_xyz',
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'gemini',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (req.providerState) {
              yield { type: 'turn_error', error: 'Expected null providerState on switch' };
              return;
            }
            yield { type: 'assistant_text_delta', text: 'Hi from Gemini' };
            yield { type: 'turn_completed', providerState: GEMINI_ENVELOPE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: OPENAI_ENVELOPE }),
        insertInto: (_table: string) => ({
          values: (values: Record<string, unknown>) => {
            if (_table === 'messages') insertedMessages.push({ ...values });
            return { execute: () => Promise.resolve() };
          },
        }),
        updateTable: () => ({
          set: (values: Record<string, unknown>) => {
            chatSetCalls.push({ ...values });
            return makeChain(undefined);
          },
        }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Hello',
          model: 'gemini-2.0-flash',
        }),
      })
    );

    expect(response.status).toBe(200);
    const rawText = await response.text();

    const sseEvents = parseSseEvents(rawText);

    // Must emit fallback_notice because of provider switch
    const fallbackNotice = sseEvents.find((e) => e.type === 'fallback_notice');
    expect(fallbackNotice).toBeDefined();
    expect(fallbackNotice).toMatchObject({
      type: 'fallback_notice',
      from: 'responses',
      to: 'replay',
    });

    // Must emit a typed continuation_transition SSE event
    const continuationTransition = sseEvents.find((e) => e.type === 'continuation_transition');
    expect(continuationTransition).toBeDefined();
    expect(continuationTransition).toMatchObject({
      type: 'continuation_transition',
      provider: 'gemini',
      fromProvider: 'openai',
      fromMode: 'responses',
      toMode: 'replay',
      reasonCode: 'provider_changed',
      done: false,
    });

    // Must persist the new Gemini cursor
    const geminiUpdate = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState === GEMINI_ENVELOPE
    );
    expect(geminiUpdate).toBeDefined();

    // Persisted AI message must contain a continuation_transition part with recovered=true
    const aiMessage = insertedMessages.find((m) => m.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    const transitionPart = parts.find((p) => p.type === 'continuation_transition');
    expect(transitionPart).toBeDefined();
    expect(transitionPart).toMatchObject({
      type: 'continuation_transition',
      provider: 'gemini',
      fromProvider: 'openai',
      fromMode: 'responses',
      toMode: 'replay',
      reasonCode: 'provider_changed',
      recovered: true,
    });
  });

  it('uses Gemini cursor on subsequent turn after provider switch', async () => {
    const GEMINI_ENVELOPE = JSON.stringify({
      schemaVersion: 1,
      provider: 'gemini',
      mode: 'interactions',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'none',
      toolsetHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      cursor: 'interaction_xyz',
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'gemini',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (req.providerState !== GEMINI_ENVELOPE) {
              yield { type: 'turn_error', error: 'Expected Gemini cursor' };
              return;
            }
            yield { type: 'assistant_text_delta', text: 'Continuing' };
            yield { type: 'turn_completed', providerState: GEMINI_ENVELOPE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: GEMINI_ENVELOPE }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => makeChain(undefined),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Next message',
          model: 'gemini-2.0-flash',
        }),
      })
    );

    expect(response.status).toBe(200);
    const rawText = await response.text();

    const sseEvents = parseSseEvents(rawText);

    const textEvent = sseEvents.find((e) => e.type === 'text');
    expect(textEvent).toBeDefined();
    expect(textEvent?.text).toBe('Continuing');

    const doneEvent = sseEvents.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
  });

  it('always replays for openai-compatible with no cross-turn cursor', async () => {
    const chatSetCalls: Array<Record<string, unknown>> = [];

    const STATELESS_STATE = JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'none',
      toolsetHash: 'none',
      loopMessages: [{ role: 'user', content: 'Hello' }],
    });

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            if (req.providerState) {
              yield { type: 'turn_error', error: 'Expected null providerState' };
              return;
            }
            yield { type: 'assistant_text_delta', text: 'Hi' };
            yield { type: 'turn_completed', providerState: STATELESS_STATE };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: () => [],
      getToolDefinitionsForAgent: () => [],
      executeTool: () => Promise.resolve({}),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id, lastProviderState: STATELESS_STATE }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({
          set: (values: Record<string, unknown>) => {
            chatSetCalls.push({ ...values });
            return makeChain(undefined);
          },
        }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'Hello',
          model: 'deepseek-chat',
        }),
      })
    );

    expect(response.status).toBe(200);
    await response.text();

    // chats.lastProviderState must never be set to a non-null value
    const durableUpdate = chatSetCalls.find(
      (u) => 'lastProviderState' in u && u.lastProviderState !== null
    );
    expect(durableUpdate).toBeUndefined();
  });

  it('streams generated image lifecycle events and persists completed artifacts', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    const insertedGeneratedImages: Array<Record<string, unknown>> = [];
    const generateImageRequests: Array<Record<string, unknown>> = [];
    let iteration = 0;
    let capturedToolResults: AgentTurnRequest['toolResults'];

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: realGetAllToolDefinitions,
      getToolDefinitionsForAgent: realGetToolDefinitionsForAgent,
      executeTool: realExecuteTool,
      getTool: realGetTool,
      getSafeEffectiveToolSettings: realGetSafeEffectiveToolSettings,
    }));

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateImage: (request: Record<string, unknown>) => {
            generateImageRequests.push({ ...request });
            return Promise.resolve({
              imageUrl: `/images/generated-${generateImageRequests.length}.png`,
            });
          },
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            iteration += 1;

            if (iteration === 1) {
              yield { type: 'tool_call_started', callId: 'image-call-1', name: 'generate_image' };
              yield {
                type: 'tool_call_completed',
                callId: 'image-call-1',
                name: 'generate_image',
                arguments: JSON.stringify({
                  prompt: 'Paint mangoes',
                  count: 2,
                  model: 'test-image-model',
                }),
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }

            capturedToolResults = req.toolResults;
            yield { type: 'assistant_text_delta', text: 'Images ready' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    const dbMock: Record<string, unknown> = {};
    Object.assign(dbMock, {
      selectFrom: () => makeChain({ userId: TEST_USER.id }),
      insertInto: (table: string) => ({
        values: (values: Record<string, unknown>) => {
          if (table === 'messages') insertedMessages.push({ ...values });
          if (table === 'generated_images') insertedGeneratedImages.push({ ...values });
          return { execute: () => Promise.resolve() };
        },
      }),
      updateTable: () => ({ set: () => makeChain(undefined) }),
      transaction: () => ({
        execute: (callback: (trx: Record<string, unknown>) => Promise<unknown>) => callback(dbMock),
      }),
    });

    await mock.module('../../../src/db/database', () => ({ getDb: () => dbMock }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Make images', model: 'test-model' }),
      })
    );
    const rawText = await response.text();
    const sseEvents = parseSseEvents(rawText);

    expect(response.status).toBe(200);

    const startedEvents = sseEvents.filter((event) => event.type === 'image_generation_started');
    const completedEvents = sseEvents.filter(
      (event) => event.type === 'image_generation_completed'
    );
    expect(startedEvents).toHaveLength(2);
    expect(completedEvents).toHaveLength(2);
    expect(completedEvents.map((event) => event.imageUrl)).toEqual([
      '/images/generated-1.png',
      '/images/generated-2.png',
    ]);

    expect(generateImageRequests).toHaveLength(2);
    expect(generateImageRequests[0]).toMatchObject({
      userId: TEST_USER.id,
      prompt: 'Paint mangoes',
      imageSize: '1K',
      modelName: 'test-image-model',
    });

    const streamedToolResult = sseEvents.find(
      (event) => event.type === 'tool_result' && event.name === 'generate_image'
    );
    expect(streamedToolResult?.isError).toBe(false);
    expect(streamedToolResult?.result).toMatchObject({
      count: 2,
      images: [
        { imageUrl: '/images/generated-1.png', modelName: 'test-image-model' },
        { imageUrl: '/images/generated-2.png', modelName: 'test-image-model' },
      ],
    });

    expect(capturedToolResults).toHaveLength(1);
    const modelFeedback = JSON.parse(capturedToolResults?.[0]?.result ?? '{}') as {
      images: Array<{ imageUrl: string }>;
    };
    expect(modelFeedback.images.map((image) => image.imageUrl)).toEqual([
      '/images/generated-1.png',
      '/images/generated-2.png',
    ]);

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    const toolCallIndex = parts.findIndex(
      (part) => part.type === 'tool_call' && part.name === 'generate_image'
    );
    const imageParts = parts.filter((part) => part.type === 'generated_image');
    expect(imageParts).toHaveLength(2);
    expect(toolCallIndex).toBeGreaterThanOrEqual(0);
    expect(parts.indexOf(imageParts[0])).toBeGreaterThan(toolCallIndex);
    expect(parts.indexOf(imageParts[1])).toBeGreaterThan(parts.indexOf(imageParts[0]));
    expect(imageParts[0]).toMatchObject({
      type: 'generated_image',
      toolCallId: 'image-call-1',
      status: 'completed',
      prompt: 'Paint mangoes',
      imageUrl: '/images/generated-1.png',
      modelName: 'test-image-model',
    });
    expect(imageParts[1]).toMatchObject({
      type: 'generated_image',
      toolCallId: 'image-call-1',
      status: 'completed',
      prompt: 'Paint mangoes',
      imageUrl: '/images/generated-2.png',
      modelName: 'test-image-model',
    });

    expect(insertedGeneratedImages).toHaveLength(2);
    expect(insertedGeneratedImages.map((artifact) => artifact.imageUrl)).toEqual([
      '/images/generated-1.png',
      '/images/generated-2.png',
    ]);
    expect(insertedGeneratedImages.map((artifact) => artifact.toolCallId)).toEqual([
      'image-call-1',
      'image-call-1',
    ]);
    expect(insertedGeneratedImages[0]).toMatchObject({
      userId: TEST_USER.id,
      chatId: 'test-chat',
      prompt: 'Paint mangoes',
      modelName: 'test-image-model',
      metadataJson: JSON.stringify({ quality: '1K' }),
    });
  });

  it('omits disabled tools from provider requests', async () => {
    let capturedToolDefinitions: AgentTurnRequest['toolDefinitions'];

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module(
      '../../../src/modules/tool-settings/infrastructure/tool-settings-repository',
      () => ({
        listSavedToolSettings: () =>
          Promise.resolve(
            new Map([
              ['get_current_datetime', { enabled: false, parameters: {} }],
              ['generate_image', { enabled: false, parameters: {} }],
            ])
          ),
      })
    );

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            capturedToolDefinitions = req.toolDefinitions;
            yield { type: 'assistant_text_delta', text: 'Hi' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'test-chat', prompt: 'Hello', model: 'test-model' }),
      })
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(capturedToolDefinitions?.map((definition) => definition.name)).not.toContain(
      'get_current_datetime'
    );
    expect(capturedToolDefinitions?.map((definition) => definition.name)).not.toContain(
      'generate_image'
    );
  });

  it('passes saved tool parameters into execution context', async () => {
    let iteration = 0;

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module(
      '../../../src/modules/tool-settings/infrastructure/tool-settings-repository',
      () => ({
        listSavedToolSettings: () =>
          Promise.resolve(
            new Map([
              [
                'get_current_datetime',
                { enabled: true, parameters: { timezone: 'America/Sao_Paulo', locale: 'pt-BR' } },
              ],
            ])
          ),
      })
    );

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (_req: AgentTurnRequest) {
            await Promise.resolve();
            iteration += 1;
            if (iteration === 1) {
              yield { type: 'tool_call_started', callId: 'time-1', name: 'get_current_datetime' };
              yield {
                type: 'tool_call_completed',
                callId: 'time-1',
                name: 'get_current_datetime',
                arguments: '{}',
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }
            yield { type: 'assistant_text_delta', text: 'Done' };
            yield { type: 'turn_completed', providerState: null };
          },
        }),
    }));

    await mock.module('../../../src/services/tools', () => ({
      getAllToolDefinitions: realGetAllToolDefinitions,
      getToolDefinitionsForAgent: realGetToolDefinitionsForAgent,
      executeTool: realExecuteTool,
      getTool: realGetTool,
      getSafeEffectiveToolSettings: realGetSafeEffectiveToolSettings,
    }));

    await mock.module('../../../src/db/database', () => ({
      getDb: () => ({
        selectFrom: () => makeChain({ userId: TEST_USER.id }),
        insertInto: () => ({ values: () => ({ execute: () => Promise.resolve() }) }),
        updateTable: () => ({ set: () => makeChain(undefined) }),
      }),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/respond/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 'test-chat',
          prompt: 'What time is it?',
          model: 'test-model',
        }),
      })
    );
    const rawText = await response.text();
    const toolResult = parseSseEvents(rawText).find((event) => event.type === 'tool_result');

    expect(response.status).toBe(200);
    expect(toolResult?.result).toMatchObject({ timezone: 'America/Sao_Paulo', locale: 'pt-BR' });
  });
});
