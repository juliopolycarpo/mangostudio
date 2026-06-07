import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import type { AgentTurnRequest } from '../../../src/services/providers/types';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  makeAgentProfile,
  makeChain,
  parsePersistedParts,
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

describe('POST /respond/stream — tool execution edge cases', () => {
  it('returns an error result when a tool is disabled for the user', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    let iteration = 0;

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, _agentId: string) =>
        Promise.resolve(
          makeAgentProfile({
            id: 'default',
            name: 'Default',
            role: 'both',
            systemPrompt: 'Default agent.',
            toolNames: ['get_current_datetime'],
            toolsEnabled: true,
          })
        ),
    }));

    await mock.module('../../../src/services/tools', () => {
      const toolDefinition = {
        name: 'get_current_datetime',
        description: 'Get current time',
        parameters: {},
      };

      return {
        getAllToolDefinitions: () => [toolDefinition],
        getToolDefinitionsForAgent: () => [toolDefinition],
        getTool: () => ({
          definition: toolDefinition,
          settings: {
            title: 'DateTime',
            description: 'Get current time',
            category: 'system',
            enabledByDefault: true,
            canDisable: true,
            defaultParameters: {},
            parameterDescriptors: [],
          },
          execute: () => Promise.resolve({ time: '12:00' }),
        }),
        getSafeEffectiveToolSettings: () => ({ enabled: false, parameters: {} }),
        executeTool: (name: string) => {
          throw new Error(`Tool "${name}" is disabled for this user.`);
        },
      };
    });

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            iteration += 1;
            if (iteration === 1) {
              yield {
                type: 'tool_call_started',
                callId: 'time-1',
                name: 'get_current_datetime',
              };
              yield {
                type: 'tool_call_completed',
                callId: 'time-1',
                name: 'get_current_datetime',
                arguments: '{}',
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }
            const toolResult = req.toolResults?.[0];
            yield {
              type: 'assistant_text_delta',
              text: `Tool result: ${toolResult?.result ?? 'none'}`,
            };
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
          prompt: 'What time is it?',
          model: 'test-model',
        }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    const toolResultEvent = sseEvents.find(
      (event) => event.type === 'tool_result' && event.name === 'get_current_datetime'
    );
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent?.isError).toBe(true);
    expect(toolResultEvent?.result).toMatchObject({
      error: expect.stringContaining('disabled'),
    });

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    expect(aiMessage).toBeDefined();
    const parts = parsePersistedParts(aiMessage?.parts);
    const toolResultPart = parts.find(
      (part) => part.type === 'tool_result' && part.toolCallId === 'time-1'
    );
    expect(toolResultPart).toBeDefined();
    expect(toolResultPart?.isError).toBe(true);
  });

  it('returns an error result when a tool is not allowed for the agent', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    let iteration = 0;

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
      getAgentProfile: (_db: unknown, _userId: string, _agentId: string) =>
        Promise.resolve(
          makeAgentProfile({
            id: 'default',
            name: 'Default',
            role: 'both',
            systemPrompt: 'Default agent.',
            toolNames: [],
            toolsEnabled: true,
          })
        ),
    }));

    await mock.module('../../../src/services/tools', () => {
      const toolDefinition = {
        name: 'get_current_datetime',
        description: 'Get current time',
        parameters: {},
      };

      return {
        getAllToolDefinitions: () => [toolDefinition],
        getToolDefinitionsForAgent: () => [],
        getTool: () => ({
          definition: toolDefinition,
          settings: {
            title: 'DateTime',
            description: 'Get current time',
            category: 'system',
            enabledByDefault: true,
            canDisable: true,
            defaultParameters: {},
            parameterDescriptors: [],
          },
          execute: () => Promise.resolve({ time: '12:00' }),
        }),
        getSafeEffectiveToolSettings: () => ({ enabled: true, parameters: {} }),
        executeTool: () => Promise.resolve({ time: '12:00' }),
      };
    });

    await mock.module('../../../src/services/providers/core/provider-registry', () => ({
      getProviderForModel: () =>
        Promise.resolve({
          providerType: 'openai-compatible',
          generateText: () => Promise.resolve({ text: '' }),
          generateAgentTurnStream: async function* (req: AgentTurnRequest) {
            await Promise.resolve();
            iteration += 1;
            if (iteration === 1) {
              yield {
                type: 'tool_call_started',
                callId: 'time-1',
                name: 'get_current_datetime',
              };
              yield {
                type: 'tool_call_completed',
                callId: 'time-1',
                name: 'get_current_datetime',
                arguments: '{}',
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }
            const toolResult = req.toolResults?.[0];
            yield {
              type: 'assistant_text_delta',
              text: `Tool result: ${toolResult?.result ?? 'none'}`,
            };
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
          prompt: 'What time is it?',
          model: 'test-model',
        }),
      })
    );

    expect(response.status).toBe(200);
    const sseEvents = parseSseEvents(await response.text());

    const toolResultEvent = sseEvents.find(
      (event) => event.type === 'tool_result' && event.name === 'get_current_datetime'
    );
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent?.isError).toBe(true);
    expect(toolResultEvent?.result).toMatchObject({
      error: expect.stringContaining('not allowed'),
    });
  });

  it('stops delegation retry when signal is aborted during backoff', async () => {
    let delegationStarted = false;

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
            timeoutMs: 5000,
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
        delegationStarted = true;
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
              yield {
                type: 'tool_call_started',
                callId: 'delegate-1',
                name: 'delegate_to_agent',
              };
              yield {
                type: 'tool_call_completed',
                callId: 'delegate-1',
                name: 'delegate_to_agent',
                arguments: JSON.stringify({ agentId: 'user:explorer', task: 'Test abort.' }),
              };
              yield { type: 'turn_completed', providerState: null };
              return;
            }
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

    const controller = new AbortController();

    const responsePromise = app.handle(
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
        signal: controller.signal,
      })
    );

    setTimeout(() => {
      controller.abort();
    }, 10);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await response.text();

    expect(delegationStarted).toBe(true);
  });
});
