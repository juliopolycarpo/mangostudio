import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { StreamChunkSchema } from '@mangostudio/shared/streaming';
import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../src/db/database';
import { chatRoutes } from '../../../src/modules/chats/http/chat-routes';
import { respondStreamRoutes } from '../../../src/modules/generation/http/respond-stream-routes';
import { turnRecoveryRoutes } from '../../../src/modules/generation/http/turn-recovery-routes';
import { mcpServerRoutes } from '../../../src/modules/mcp-servers/http/mcp-server-routes';
import {
  closeAllMcpClients,
  setMcpClientConnectorForTest,
} from '../../../src/services/mcp/connection-manager';
import { resetElicitationRegistryForTest } from '../../../src/services/mcp/elicitation-registry';
import {
  getProvider,
  invalidateProviderRoutingCache,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
} from '../../../src/services/providers/types';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import {
  type ControlledTurnMcpFixture,
  createControlledTurnMcpFixture,
} from '../../support/fixtures/mcp/in-memory-mcp';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { SseRecorder } from '../../support/harness/sse-recorder';
import { buildRespondStreamRequest } from './_respond-stream-helpers';

const MODEL_ID = 'interactive-mcp-e2e-model';
const SERVER_SLUG = 'interactive-server';

interface ProviderToolCall {
  callId: string;
  name: string;
  args?: Record<string, unknown>;
}

class ScriptedMcpProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  readonly requests: AgentTurnRequest[] = [];
  private iteration = 0;

  constructor(private readonly calls: readonly ProviderToolCall[]) {}

  generateText(): ReturnType<AIProvider['generateText']> {
    return Promise.resolve({ text: '' });
  }

  listModels(): ReturnType<AIProvider['listModels']> {
    return Promise.resolve([]);
  }

  validateApiKey(): Promise<void> {
    return Promise.resolve();
  }

  resolveApiKey(): Promise<string> {
    return Promise.resolve('test-key');
  }

  async *generateAgentTurnStream(request: AgentTurnRequest): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    this.requests.push(request);
    this.iteration += 1;
    if (this.iteration === 1) {
      for (const call of this.calls) {
        yield { type: 'tool_call_started', callId: call.callId, name: call.name };
        yield {
          type: 'tool_call_completed',
          callId: call.callId,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        };
      }
      yield { type: 'turn_completed' };
      return;
    }
    yield { type: 'assistant_text_delta', text: 'Interactive flow complete.' };
    yield { type: 'turn_completed' };
  }
}

let user: UserFixture;
let chatId = '';
let serverId = '';
let fixture: ControlledTurnMcpFixture;
let restoreAuth: (() => void) | null = null;
let previousProvider: AIProvider;
let app: ReturnType<typeof createAuthenticatedApiTestApp>['app'];

beforeEach(async () => {
  previousProvider = getProvider('openai-compatible');
  fixture = createControlledTurnMcpFixture();
  setMcpClientConnectorForTest(fixture.connector);
  user = await insertTestUser();
  chatId = (await insertTestChat(user.id)).id;
  serverId = `${user.id}-interactive-mcp`;
  const now = Date.now();
  await getDb()
    .insertInto('secret_metadata')
    .values({
      id: `${user.id}-interactive-connector`,
      name: 'Interactive MCP Test Connector',
      provider: 'openai-compatible',
      configured: 1,
      source: 'config-file',
      maskedSuffix: null,
      updatedAt: now,
      lastValidatedAt: now,
      lastValidationError: null,
      enabledModels: JSON.stringify([MODEL_ID]),
      userId: user.id,
      baseUrl: null,
      organizationId: null,
      projectId: null,
    })
    .execute();
  await getDb()
    .insertInto('mcp_servers')
    .values({
      id: serverId,
      userId: user.id,
      name: 'Interactive Server',
      slug: SERVER_SLUG,
      transport: 'stdio',
      command: 'bun',
      argsJson: '[]',
      envJson: '{}',
      url: null,
      enabled: 1,
      timeoutMs: 2_000,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  invalidateProviderRoutingCache(user.id);
  const authenticated = createAuthenticatedApiTestApp(
    user,
    respondStreamRoutes,
    mcpServerRoutes,
    turnRecoveryRoutes,
    chatRoutes
  );
  app = authenticated.app;
  restoreAuth = authenticated.restore;
});

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  resetElicitationRegistryForTest();
  setMcpClientConnectorForTest(null);
  await closeAllMcpClients();
  await fixture.close();
  fixture.assertNoOpenServers();
  registerProvider(previousProvider);
  invalidateProviderRoutingCache(user.id);
});

function installProvider(calls: readonly ProviderToolCall[]): ScriptedMcpProvider {
  const provider = new ScriptedMcpProvider(calls);
  registerProvider(provider);
  return provider;
}

async function startStream(): Promise<{ response: Response; recorder: SseRecorder }> {
  const response = await app.handle(
    buildRespondStreamRequest({ chatId, prompt: 'Run the interactive MCP flow.', model: MODEL_ID })
  );
  expect(response.status).toBe(200);
  return { response, recorder: new SseRecorder(response) };
}

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function respondToElicitation(
  elicitationId: string,
  action: 'accept' | 'decline' | 'cancel'
): Promise<Response> {
  return app.handle(
    jsonRequest(`/mcp/elicitations/${elicitationId}/respond`, {
      action,
      ...(action === 'accept' ? { content: { tier: 'production' } } : {}),
    })
  );
}

async function reloadMessages(): Promise<Array<Record<string, unknown>>> {
  const response = await app.handle(new Request(`http://localhost/chats/${chatId}/messages`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { messages: Array<Record<string, unknown>> };
  return body.messages;
}

function assistantParts(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const assistant = messages.find((message) => message.role === 'ai');
  return (assistant?.parts ?? []) as Array<Record<string, unknown>>;
}

function assertPublicStreamSchema(events: Array<Record<string, unknown>>): void {
  for (const event of events) {
    expect(Value.Check(StreamChunkSchema, event)).toBe(true);
  }
}

function eventTypes(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => String(event.type));
}

function executionStatuses(
  events: Array<Record<string, unknown>>,
  callId: string
): Array<Pick<ToolExecutionSnapshot, 'status' | 'reasonCode'>> {
  return events
    .filter((event) => event.type === 'tool_execution' && event.callId === callId)
    .map((event) => {
      const execution = event.execution as ToolExecutionSnapshot;
      return { status: execution.status, reasonCode: execution.reasonCode };
    });
}

describe('POST /respond/stream — interactive MCP end to end', () => {
  it.each([
    ['accept', 'accepted'],
    ['decline', 'declined'],
    ['cancel', 'cancelled'],
  ] as const)('streams, persists, and reloads an elicitation %s response', async (action, expectedStatus) => {
    const provider = installProvider([{ callId: 'call-1', name: `mcp__${SERVER_SLUG}__elicit` }]);
    const { recorder } = await startStream();
    const requestEvent = await recorder.readUntil(
      (event) => event.type === 'mcp_elicitation_request'
    );
    const elicitationId = String(requestEvent.elicitationId);

    const pendingParts = assistantParts(await reloadMessages());
    expect(pendingParts).toContainEqual(
      expect.objectContaining({
        type: 'mcp_elicitation',
        elicitationId,
        toolCallId: 'call-1',
        status: 'pending',
      })
    );

    const response = await respondToElicitation(elicitationId, action);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: expectedStatus });

    const events = await recorder.finish();
    assertPublicStreamSchema(events);
    expect(eventTypes(events)).toEqual([
      'user_message_id',
      'assistant_message_id',
      'tool_call_started',
      'tool_call_completed',
      'context_info',
      'tool_execution',
      'tool_execution',
      'tool_execution',
      'mcp_elicitation_request',
      'tool_execution',
      'mcp_elicitation_status',
      'tool_execution',
      'tool_result',
      'text',
      'context_info',
      'done',
    ]);
    expect(executionStatuses(events, 'call-1').map(({ status }) => status)).toEqual([
      'queued',
      'running',
      'awaiting_user',
      'running',
      'succeeded',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'mcp_elicitation_status',
        elicitationId,
        toolCallId: 'call-1',
        status: expectedStatus,
        reason: 'responded',
      })
    );

    const terminalParts = assistantParts(await reloadMessages());
    expect(terminalParts).toContainEqual(
      expect.objectContaining({ type: 'mcp_elicitation', elicitationId, status: expectedStatus })
    );
    expect(terminalParts).toContainEqual(
      expect.objectContaining({
        type: 'tool_call',
        toolCallId: 'call-1',
        execution: expect.objectContaining({ status: 'succeeded', source: 'mcp' }),
      })
    );
    expect(provider.requests[1]?.toolResults?.[0]).toMatchObject({
      callId: 'call-1',
      isError: false,
    });

    const stale = await respondToElicitation(elicitationId, 'decline');
    expect(stale.status).toBe(404);
    expect(await stale.json()).toEqual({
      error: 'Elicitation not found or already resolved.',
      code: 'NOT_FOUND',
    });
  });

  it('distinguishes elicitation timeout from an explicit turn abort', async () => {
    await getDb()
      .updateTable('mcp_servers')
      .set({ timeoutMs: 75 })
      .where('id', '=', serverId)
      .execute();
    installProvider([{ callId: 'timeout-call', name: `mcp__${SERVER_SLUG}__elicit` }]);
    const { recorder } = await startStream();
    await recorder.readUntil((event) => event.type === 'mcp_elicitation_request');
    const events = await recorder.finish();

    assertPublicStreamSchema(events);
    expect(eventTypes(events)).toEqual([
      'user_message_id',
      'assistant_message_id',
      'tool_call_started',
      'tool_call_completed',
      'context_info',
      'tool_execution',
      'tool_execution',
      'tool_execution',
      'mcp_elicitation_request',
      'tool_execution',
      'mcp_elicitation_status',
      'tool_execution',
      'tool_result',
      'text',
      'context_info',
      'done',
    ]);
    expect(executionStatuses(events, 'timeout-call')).toEqual([
      { status: 'queued', reasonCode: undefined },
      { status: 'running', reasonCode: undefined },
      { status: 'awaiting_user', reasonCode: undefined },
      { status: 'running', reasonCode: undefined },
      { status: 'timed_out', reasonCode: 'timeout' },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'mcp_elicitation_status',
        status: 'cancelled',
        reason: 'tool_timeout',
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_result', callId: 'timeout-call', isError: true })
    );
    const persisted = assistantParts(await reloadMessages());
    expect(persisted).toContainEqual(
      expect.objectContaining({
        type: 'tool_call',
        toolCallId: 'timeout-call',
        execution: expect.objectContaining({ status: 'timed_out', reasonCode: 'timeout' }),
      })
    );
    expect(persisted).toContainEqual(
      expect.objectContaining({ type: 'mcp_elicitation', status: 'cancelled' })
    );
  });

  it('reports a failed tool when cancelling its pending elicitation', async () => {
    const provider = installProvider([
      {
        callId: 'failed-call',
        name: `mcp__${SERVER_SLUG}__fail-after-elicit`,
      },
    ]);
    const { recorder } = await startStream();
    const requestEvent = await recorder.readUntil(
      (event) => event.type === 'mcp_elicitation_request'
    );
    const elicitationId = String(requestEvent.elicitationId);

    fixture.controls.release('fail-after-elicit');
    const events = await recorder.finish();

    assertPublicStreamSchema(events);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'mcp_elicitation_status',
        elicitationId,
        toolCallId: 'failed-call',
        status: 'cancelled',
        reason: 'tool_failed',
      })
    );
    expect(executionStatuses(events, 'failed-call').at(-1)).toEqual({
      status: 'failed',
      reasonCode: 'execution_error',
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_result', callId: 'failed-call', isError: true })
    );
    expect(assistantParts(await reloadMessages())).toContainEqual(
      expect.objectContaining({
        type: 'mcp_elicitation',
        elicitationId,
        status: 'cancelled',
        reason: 'tool_failed',
      })
    );
    expect(provider.requests[1]?.toolResults?.[0]).toMatchObject({
      callId: 'failed-call',
      isError: true,
    });
  });

  it('persists turn-aborted elicitation state and hands it to recovery', async () => {
    const provider = installProvider([
      { callId: 'abort-call', name: `mcp__${SERVER_SLUG}__elicit` },
    ]);
    const { recorder } = await startStream();
    const assistantEvent = await recorder.readUntil(
      (event) => event.type === 'assistant_message_id'
    );
    const requestEvent = await recorder.readUntil(
      (event) => event.type === 'mcp_elicitation_request'
    );
    const assistantMessageId = String(assistantEvent.messageId);
    const elicitationId = String(requestEvent.elicitationId);

    const cancel = await app.handle(
      jsonRequest(`/chats/${chatId}/messages/${assistantMessageId}/recovery/cancel`, {})
    );
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ messageId: assistantMessageId, status: 'interrupted' });
    const abortedEvents = await recorder.finish();
    assertPublicStreamSchema(abortedEvents);

    const interruptedParts = assistantParts(await reloadMessages());
    expect(interruptedParts).toContainEqual(
      expect.objectContaining({
        type: 'mcp_elicitation',
        elicitationId,
        status: 'cancelled',
      })
    );
    expect(interruptedParts).toContainEqual(
      expect.objectContaining({
        type: 'turn_checkpoint',
        status: 'interrupted',
        reasonCode: 'user_cancelled',
      })
    );
    expect(interruptedParts).toContainEqual(
      expect.objectContaining({
        type: 'tool_call',
        toolCallId: 'abort-call',
        execution: expect.objectContaining({
          status: 'cancelled',
          reasonCode: 'user_cancelled',
        }),
      })
    );

    const stale = await respondToElicitation(elicitationId, 'accept');
    expect(stale.status).toBe(404);

    const recoveryResponse = await app.handle(
      buildRespondStreamRequest({
        chatId,
        prompt: 'Resume the interrupted work.',
        model: MODEL_ID,
        recovery: {
          messageId: assistantMessageId,
          requestId: crypto.randomUUID(),
          retryCallIds: [],
        },
      })
    );
    expect(recoveryResponse.status).toBe(200);
    const recoveryEvents = await new SseRecorder(recoveryResponse).finish();
    assertPublicStreamSchema(recoveryEvents);
    const resumedAssistantId = String(
      recoveryEvents.find((event) => event.type === 'assistant_message_id')?.messageId
    );
    expect(resumedAssistantId).not.toBe(assistantMessageId);
    expect(recoveryEvents.at(-1)).toMatchObject({
      type: 'done',
      messageId: resumedAssistantId,
      done: true,
    });
    const resumedSource = assistantParts(await reloadMessages()).find(
      (part) => part.type === 'turn_checkpoint' && part.turnId === assistantMessageId
    );
    expect(resumedSource).toMatchObject({
      status: 'resumed',
      resume: expect.objectContaining({ assistantMessageId: resumedAssistantId }),
    });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.prompt).toContain('durable recovery checkpoint');
    expect(provider.requests[1]?.prompt).toContain('abort-call');
  });

  it('normalizes a server disconnect as a failed lifecycle and still completes the turn', async () => {
    installProvider([{ callId: 'disconnect-call', name: `mcp__${SERVER_SLUG}__disconnect` }]);
    const { recorder } = await startStream();
    const events = await recorder.finish();

    assertPublicStreamSchema(events);
    expect(eventTypes(events)).toEqual([
      'user_message_id',
      'assistant_message_id',
      'tool_call_started',
      'tool_call_completed',
      'context_info',
      'tool_execution',
      'tool_execution',
      'tool_execution',
      'tool_result',
      'text',
      'context_info',
      'done',
    ]);
    expect(executionStatuses(events, 'disconnect-call')).toEqual([
      { status: 'queued', reasonCode: undefined },
      { status: 'running', reasonCode: undefined },
      { status: 'failed', reasonCode: 'server_closed' },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_result', callId: 'disconnect-call', isError: true })
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', done: true });
    expect(assistantParts(await reloadMessages())).toContainEqual(
      expect.objectContaining({
        type: 'tool_call',
        toolCallId: 'disconnect-call',
        execution: expect.objectContaining({ status: 'failed', reasonCode: 'server_closed' }),
      })
    );
  });

  it('holds delayed execution on an explicit fixture barrier', async () => {
    installProvider([
      {
        callId: 'delayed-call',
        name: `mcp__${SERVER_SLUG}__delayed`,
        args: { key: 'release-delayed-call' },
      },
    ]);
    const { recorder } = await startStream();

    await fixture.controls.waitForCall('delayed');
    await recorder.readUntil(
      (event) =>
        event.type === 'tool_execution' &&
        event.callId === 'delayed-call' &&
        (event.execution as ToolExecutionSnapshot).status === 'running'
    );
    expect(
      recorder.events.some(
        (event) => event.type === 'tool_result' && event.callId === 'delayed-call'
      )
    ).toBe(false);

    fixture.controls.release('release-delayed-call');
    const events = await recorder.finish();
    assertPublicStreamSchema(events);
    expect(eventTypes(events)).toEqual([
      'user_message_id',
      'assistant_message_id',
      'tool_call_started',
      'tool_call_completed',
      'context_info',
      'tool_execution',
      'tool_execution',
      'tool_execution',
      'tool_result',
      'text',
      'context_info',
      'done',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        callId: 'delayed-call',
        result: 'released:release-delayed-call',
        isError: false,
      })
    );
    expect(assistantParts(await reloadMessages())).toContainEqual(
      expect.objectContaining({
        type: 'tool_call',
        toolCallId: 'delayed-call',
        execution: expect.objectContaining({ status: 'succeeded', source: 'mcp' }),
      })
    );
  });

  it('serializes and correlates two same-server elicitations', async () => {
    installProvider([
      { callId: 'call-a', name: `mcp__${SERVER_SLUG}__elicit` },
      { callId: 'call-b', name: `mcp__${SERVER_SLUG}__elicit` },
    ]);
    const { recorder } = await startStream();
    const first = await recorder.readUntil(
      (event) => event.type === 'mcp_elicitation_request' && event.toolCallId === 'call-a'
    );
    expect(fixture.controls.callStarts).toEqual(['elicit']);
    expect((await respondToElicitation(String(first.elicitationId), 'accept')).status).toBe(200);

    const second = await recorder.readUntil(
      (event) => event.type === 'mcp_elicitation_request' && event.toolCallId === 'call-b'
    );
    expect(fixture.controls.callStarts).toEqual(['elicit', 'elicit']);
    expect((await respondToElicitation(String(second.elicitationId), 'decline')).status).toBe(200);

    const events = await recorder.finish();
    assertPublicStreamSchema(events);
    const requests = events.filter((event) => event.type === 'mcp_elicitation_request');
    expect(requests.map((event) => event.toolCallId)).toEqual(['call-a', 'call-b']);
    expect(requests[0]?.elicitationId).not.toBe(requests[1]?.elicitationId);
    expect(executionStatuses(events, 'call-a').at(-1)?.status).toBe('succeeded');
    expect(executionStatuses(events, 'call-b').at(-1)?.status).toBe('succeeded');
    const persisted = assistantParts(await reloadMessages());
    for (const callId of ['call-a', 'call-b']) {
      expect(persisted).toContainEqual(
        expect.objectContaining({
          type: 'tool_call',
          toolCallId: callId,
          execution: expect.objectContaining({ status: 'succeeded', source: 'mcp' }),
        })
      );
    }
  });
});
