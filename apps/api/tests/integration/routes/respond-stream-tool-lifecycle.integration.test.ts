import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  buildRespondStreamRequest,
  makeChain,
  mockProviderRegistry,
  mockVerifiedChatOwnership,
  parsePersistedParts,
  parseSseEvents,
  realExecuteTool,
  realGetAllToolDefinitions,
  realGetSafeEffectiveToolSettings,
  realGetTool,
  realGetToolDefinitionsForAgent,
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
    getAllToolDefinitions: realGetAllToolDefinitions,
    getToolDefinitionsForAgent: realGetToolDefinitionsForAgent,
    executeTool: realExecuteTool,
    getTool: realGetTool,
    getSafeEffectiveToolSettings: realGetSafeEffectiveToolSettings,
  }));
}

function mockMessageCapturingDb(insertedMessages: Array<Record<string, unknown>>) {
  const dbMock: Record<string, unknown> = {};
  Object.assign(dbMock, {
    selectFrom: () => makeChain({ userId: TEST_USER.id }),
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => {
        if (table === 'messages') insertedMessages.push({ ...values });
        return { execute: () => Promise.resolve() };
      },
    }),
    updateTable: () => ({ set: () => makeChain(undefined) }),
    transaction: () => ({
      execute: (callback: (trx: Record<string, unknown>) => Promise<unknown>) => callback(dbMock),
    }),
  });
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
});
