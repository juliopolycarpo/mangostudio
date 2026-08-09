import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  buildRespondStreamRequest,
  createTestStreamDb,
  makeAgentProfile,
  mockProviderRegistry,
  mockVerifiedChatOwnership,
  parsePersistedParts,
  parseSseEvents,
  realExecuteTool,
  realGetAllToolDefinitions,
  realGetAllTools,
  realGetSafeEffectiveToolSettings,
  realGetTool,
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

interface ToolExecutionEvent {
  type: 'tool_execution';
  callId: string;
  name: string;
  execution: ToolExecutionSnapshot;
}

function toolExecutionEvents(
  events: Array<Record<string, unknown>>,
  callId: string
): ToolExecutionSnapshot[] {
  return events
    .filter(
      (event): event is Record<string, unknown> & ToolExecutionEvent =>
        event.type === 'tool_execution' && event.callId === callId
    )
    .map((event) => event.execution);
}

async function mockRealTools(): Promise<void> {
  await mock.module('../../../src/services/tools', () => ({
    getAllTools: realGetAllTools,
    getAllToolDefinitions: realGetAllToolDefinitions,
    executeTool: realExecuteTool,
    getTool: realGetTool,
    getSafeEffectiveToolSettings: realGetSafeEffectiveToolSettings,
  }));
}

async function mockRejectedToolPolicy(options: {
  exists: boolean;
  enabled: boolean;
}): Promise<void> {
  let settingsResolutionCount = 0;
  const definition = {
    name: 'policy_probe',
    description: 'Probe tool policy handling',
    parameters: {},
  };
  const tool = {
    definition,
    settings: {
      title: 'Policy probe',
      description: 'Probe tool policy handling',
      category: 'system' as const,
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute: () => Promise.resolve({ ok: true }),
  };

  await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
    getAgentProfile: () =>
      Promise.resolve(
        makeAgentProfile({
          id: 'default',
          name: 'Default',
          role: 'both',
          systemPrompt: 'Chat agent.',
          toolNames: ['policy_probe'],
          toolsEnabled: true,
        })
      ),
  }));
  await mock.module('../../../src/services/tools', () => ({
    getAllTools: () => [tool],
    getAllToolDefinitions: () => [definition],
    getTool: () => (options.exists ? tool : undefined),
    getSafeEffectiveToolSettings: () => ({
      // A disabled call was already advertised to the provider before the
      // saved setting changed; the pre-dispatch lookup sees the new policy.
      enabled: options.enabled || settingsResolutionCount++ === 0,
      parameters: {},
    }),
    executeTool: () => {
      throw new Error('Policy-rejected tools must not be dispatched.');
    },
  }));
}

async function streamSingleToolCall(name: string) {
  let iteration = 0;
  await mockProviderRegistry(async function* streamToolCall() {
    await Promise.resolve();
    iteration += 1;
    if (iteration !== 1) {
      yield { type: 'assistant_text_delta', text: 'Done' };
      yield { type: 'turn_completed', providerState: null };
      return;
    }
    yield { type: 'tool_call_started', callId: 'policy-1', name };
    yield { type: 'tool_call_completed', callId: 'policy-1', name, arguments: '{}' };
    yield { type: 'turn_completed', providerState: null };
  });
}

function mockMessageCapturingDb(insertedMessages: Array<Record<string, unknown>>) {
  const dbMock = createTestStreamDb({ userId: TEST_USER.id, insertedMessages });
  return mock.module('../../../src/db/database', () => ({ getDb: () => dbMock }));
}

describe('POST /respond/stream — tool execution lifecycle', () => {
  it('streams queued→running→succeeded transitions and persists terminal snapshots for concurrent calls', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    let iteration = 0;

    await mockVerifiedChatOwnership();
    await mockRealTools();

    await mockProviderRegistry(async function* streamTwoToolCalls() {
      await Promise.resolve();
      iteration += 1;
      if (iteration !== 1) {
        yield { type: 'assistant_text_delta', text: 'Done' };
        yield { type: 'turn_completed', providerState: null };
        return;
      }
      yield { type: 'tool_call_started', callId: 'time-1', name: 'get_current_datetime' };
      yield {
        type: 'tool_call_completed',
        callId: 'time-1',
        name: 'get_current_datetime',
        arguments: '{}',
      };
      yield { type: 'tool_call_started', callId: 'time-2', name: 'get_current_datetime' };
      yield {
        type: 'tool_call_completed',
        callId: 'time-2',
        name: 'get_current_datetime',
        arguments: '{}',
      };
      yield { type: 'turn_completed', providerState: null };
    });

    await mockMessageCapturingDb(insertedMessages);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({ chatId: 'test-chat', prompt: 'Times', model: 'test-model' })
    );
    const sseEvents = parseSseEvents(await response.text());

    expect(response.status).toBe(200);

    for (const callId of ['time-1', 'time-2']) {
      const transitions = toolExecutionEvents(sseEvents, callId);
      expect(transitions.map((snapshot) => snapshot.status)).toEqual([
        'queued',
        'running',
        'succeeded',
      ]);
      const terminal = transitions.at(-1);
      expect(terminal?.source).toBe('builtin');
      expect(terminal?.startedAt).toBeGreaterThanOrEqual(terminal?.queuedAt ?? 0);
      expect(terminal?.finishedAt).toBeGreaterThanOrEqual(terminal?.startedAt ?? 0);
      expect(terminal?.durationMs).toBeGreaterThanOrEqual(0);
    }

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    const parts = parsePersistedParts(aiMessage?.parts);
    const toolCallParts = parts.filter((part) => part.type === 'tool_call');
    expect(toolCallParts).toHaveLength(2);
    for (const part of toolCallParts) {
      expect(part.execution).toMatchObject({ status: 'succeeded', source: 'builtin' });
    }
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'turn_checkpoint',
        status: 'completed',
        completedCalls: [
          expect.objectContaining({ callId: 'time-1' }),
          expect.objectContaining({ callId: 'time-2' }),
        ],
        incompleteCalls: [],
      })
    );
  });

  it('marks a disallowed tool as failed with the not_allowed reason and no start time', async () => {
    const insertedMessages: Array<Record<string, unknown>> = [];
    let iteration = 0;

    await mockVerifiedChatOwnership();
    await mockRealTools();

    await mockProviderRegistry(async function* streamUnknownToolCall() {
      await Promise.resolve();
      iteration += 1;
      if (iteration !== 1) {
        yield { type: 'assistant_text_delta', text: 'Done' };
        yield { type: 'turn_completed', providerState: null };
        return;
      }
      yield { type: 'tool_call_started', callId: 'ghost-1', name: 'nonexistent_tool' };
      yield {
        type: 'tool_call_completed',
        callId: 'ghost-1',
        name: 'nonexistent_tool',
        arguments: '{}',
      };
      yield { type: 'turn_completed', providerState: null };
    });

    await mockMessageCapturingDb(insertedMessages);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      buildRespondStreamRequest({ chatId: 'test-chat', prompt: 'Try it', model: 'test-model' })
    );
    const sseEvents = parseSseEvents(await response.text());

    expect(response.status).toBe(200);

    const transitions = toolExecutionEvents(sseEvents, 'ghost-1');
    expect(transitions.map((snapshot) => snapshot.status)).toEqual(['queued', 'failed']);
    const terminal = transitions.at(-1);
    expect(terminal?.reasonCode).toBe('not_allowed');
    expect(terminal?.startedAt).toBeUndefined();
    expect(terminal?.finishedAt).toBeGreaterThanOrEqual(terminal?.queuedAt ?? 0);

    const streamedToolResult = sseEvents.find(
      (event) => event.type === 'tool_result' && event.callId === 'ghost-1'
    );
    expect(streamedToolResult?.isError).toBe(true);

    const aiMessage = insertedMessages.find((message) => message.role === 'ai');
    const parts = parsePersistedParts(aiMessage?.parts);
    const toolCallPart = parts.find((part) => part.type === 'tool_call');
    expect(toolCallPart?.execution).toMatchObject({
      status: 'failed',
      reasonCode: 'not_allowed',
    });
  });

  for (const policyCase of [
    { label: 'unknown', exists: false, enabled: true, reasonCode: 'unknown_tool' },
    { label: 'disabled', exists: true, enabled: false, reasonCode: 'tool_disabled' },
  ] as const) {
    it(`rejects a ${policyCase.label} tool from queued without recording a start time`, async () => {
      const insertedMessages: Array<Record<string, unknown>> = [];

      await mockVerifiedChatOwnership();
      await mockRejectedToolPolicy(policyCase);
      await streamSingleToolCall('policy_probe');
      await mockMessageCapturingDb(insertedMessages);

      const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, respondStreamRoutes);
      restoreAuth = restore;

      const response = await app.handle(
        buildRespondStreamRequest({ chatId: 'test-chat', prompt: 'Probe', model: 'test-model' })
      );
      const sseEvents = parseSseEvents(await response.text());

      expect(response.status).toBe(200);
      const transitions = toolExecutionEvents(sseEvents, 'policy-1');
      expect(transitions.map((snapshot) => snapshot.status)).toEqual(['queued', 'failed']);
      expect(transitions.at(-1)).toMatchObject({
        status: 'failed',
        reasonCode: policyCase.reasonCode,
      });
      expect(transitions.at(-1)?.startedAt).toBeUndefined();

      const aiMessage = insertedMessages.find((message) => message.role === 'ai');
      const parts = parsePersistedParts(aiMessage?.parts);
      const toolCallPart = parts.find(
        (part) => part.type === 'tool_call' && part.toolCallId === 'policy-1'
      );
      const persistedExecution = toolCallPart?.execution as ToolExecutionSnapshot | undefined;
      expect(persistedExecution).toMatchObject({
        status: 'failed',
        reasonCode: policyCase.reasonCode,
      });
      expect(persistedExecution?.startedAt).toBeUndefined();
    });
  }
});
