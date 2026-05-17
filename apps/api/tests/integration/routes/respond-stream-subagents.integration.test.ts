import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import type { AgentProfile } from '@mangostudio/shared/agents';
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

describe('POST /respond/stream — subagent delegation', () => {
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
        // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
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
});
