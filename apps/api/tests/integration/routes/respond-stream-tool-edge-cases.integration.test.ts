import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import type { AgentTurnRequest } from '../../../src/services/providers/types';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  createTestStreamDb,
  makeAgentProfile,
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
      getOwnedChat: () =>
        Promise.resolve({
          runner: { kind: 'mangostudio', agentId: 'default' },
          workdir: null,
          environmentId: 'local',
          restrictToolsToWorkdir: null,
        }),
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
      const registeredTool = {
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
      };

      return {
        getAllTools: () => [registeredTool],
        getAllToolDefinitions: () => [toolDefinition],
        getTool: () => registeredTool,
        // Enabled at definition time so the model still sees the tool; the
        // user disables it before execution, which rejects the stale call.
        getSafeEffectiveToolSettings: () => ({ enabled: true, parameters: {} }),
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

    const dbMock = createTestStreamDb({ userId: TEST_USER.id, insertedMessages });
    await mock.module('../../../src/db/database', () => ({ getDb: () => dbMock }));

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
      getOwnedChat: () =>
        Promise.resolve({
          runner: { kind: 'mangostudio', agentId: 'default' },
          workdir: null,
          environmentId: 'local',
          restrictToolsToWorkdir: null,
        }),
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
        getAllTools: () => [],
        getAllToolDefinitions: () => [toolDefinition],
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

    const dbMock = createTestStreamDb({ userId: TEST_USER.id, insertedMessages });
    await mock.module('../../../src/db/database', () => ({ getDb: () => dbMock }));

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

  it('stops delegation retry when the stream is aborted during backoff', async () => {
    let delegationCallCount = 0;
    // Simulates a client disconnect: the route aborts streamTextTurn's signal
    // from the ReadableStream's cancel() callback, so cancelling the reader is
    // how a real abort reaches the delegation retry loop.
    let cancelStream: (() => void) | undefined;

    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
      getOwnedChat: () =>
        Promise.resolve({
          runner: { kind: 'mangostudio', agentId: 'default' },
          workdir: null,
          environmentId: 'local',
          restrictToolsToWorkdir: null,
        }),
    }));

    await mock.module('../../../src/modules/app-settings/application/app-settings-service', () => ({
      getAppSettings: () =>
        Promise.resolve({
          multiAgentSettings: {
            enabled: true,
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
        delegationCallCount += 1;
        // Abort synchronously on the first attempt: the empty result below is
        // invalid, so without the abort the loop would retry up to 4 times.
        // Aborting here must stop it before attempt 2's backoff completes.
        cancelStream?.();
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

    await mock.module('../../../src/services/tools', () => {
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
        execute: () => Promise.resolve({}),
      };

      return {
        getAllTools: () => [delegateTool],
        getAllToolDefinitions: () => [delegateTool.definition],
        getTool: () => delegateTool,
        getSafeEffectiveToolSettings: () => ({ enabled: true, parameters: {} }),
        executeTool: () => Promise.resolve({}),
      };
    });

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

    const dbMock = createTestStreamDb({ userId: TEST_USER.id });
    await mock.module('../../../src/db/database', () => ({ getDb: () => dbMock }));

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

    const body = response.body;
    if (!body) throw new Error('Expected an SSE response body stream.');
    const reader = body.getReader();
    cancelStream = () => void reader.cancel();
    // Drive the stream to completion. runSubagentTurn cancels it on the first
    // attempt, which aborts the signal before attempt 2's backoff elapses.
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Abort lands inside attempt 1, so every later attempt short-circuits in
    // sleepWithAbort and never re-invokes the subagent. The original test only
    // checked that delegation started, which passed even though the abort was
    // a no-op and all 4 attempts actually ran.
    expect(delegationCallCount).toBe(1);
  });
});
