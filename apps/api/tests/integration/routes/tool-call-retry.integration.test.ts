import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';
import { isTurnCheckpointPart, type TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import type { MessagePart } from '@mangostudio/shared/types';

import { getDb } from '../../../src/db/database';
import {
  cancelActiveTurn,
  isActiveTurn,
} from '../../../src/modules/generation/application/active-turn-registry';
import { reserveToolCallRetry } from '../../../src/modules/generation/application/tool-call-retry';
import { createTurnCheckpointPart } from '../../../src/modules/generation/application/turn-checkpoint';
import { interruptCheckpointedMessage } from '../../../src/modules/generation/application/turn-recovery';
import { toolCallRetryRoutes } from '../../../src/modules/generation/http/tool-call-retry-routes';
import { insertMessage } from '../../../src/modules/messages/infrastructure/message-repository';
import type { RegisteredTool } from '../../../src/services/tools/types';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';
import {
  makeAgentProfile,
  makeRegisteredTool,
  mockAgentSettings,
  mockToolsModule,
  parseSseEvents,
  resetStreamTestState,
} from './_respond-stream-helpers';

const READ_TOOL = 'retry_fixture_read';
const WRITE_TOOL = 'retry_fixture_write';
const BLOCKING_TOOL = 'retry_fixture_blocking';

let testUser!: UserFixture;
let restoreAuth: (() => void) | null = null;
/** Calls the named fake tools received, in order. */
let toolRuns: Array<{ name: string; args: Record<string, unknown> }> = [];
let releaseBlockingTool: (() => void) | null = null;
let blockingToolEntered: Promise<void> = Promise.resolve();

beforeAll(async () => {
  testUser = await insertTestUser();
});

function fakeTool(
  name: string,
  retrySafety?: 'safe_read' | 'confirmation_required'
): RegisteredTool {
  const tool = makeRegisteredTool(name, `${name} fixture`, (args) => {
    toolRuns.push({ name, args });
    return Promise.resolve({ ok: true, name });
  });
  return retrySafety ? { ...tool, settings: { ...tool.settings, retrySafety } } : tool;
}

function blockingFakeTool(): RegisteredTool {
  const tool = makeRegisteredTool(BLOCKING_TOOL, 'Waits until the test releases it', (args) => {
    toolRuns.push({ name: BLOCKING_TOOL, args });
    return new Promise((resolve) => {
      releaseBlockingTool = () => resolve({ ok: true });
      markEntered();
    });
  });
  return { ...tool, settings: { ...tool.settings, retrySafety: 'safe_read' } };
}
let markEntered: () => void = () => {};

beforeEach(async () => {
  toolRuns = [];
  releaseBlockingTool = null;
  blockingToolEntered = new Promise((resolve) => {
    markEntered = resolve;
  });
  await mockToolsModule([
    fakeTool(READ_TOOL, 'safe_read'),
    fakeTool(WRITE_TOOL, 'confirmation_required'),
    blockingFakeTool(),
  ]);
  mockAgentSettings(() => ({
    getAgentProfile: () =>
      Promise.resolve(
        makeAgentProfile({
          id: 'default',
          toolsEnabled: true,
          toolNames: [READ_TOOL, WRITE_TOOL, BLOCKING_TOOL],
        })
      ),
  }));
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  resetStreamTestState();
});

function endedCall(
  toolCallId: string,
  name: string,
  execution: Partial<ToolExecutionSnapshot> & Pick<ToolExecutionSnapshot, 'status'>,
  args: Record<string, unknown> = { path: 'notes.md' }
): MessagePart[] {
  return [
    {
      type: 'tool_call',
      toolCallId,
      name,
      args,
      execution: { source: 'builtin', queuedAt: 1, startedAt: 2, finishedAt: 3, ...execution },
    },
    {
      type: 'tool_result',
      toolCallId,
      content: JSON.stringify({ error: 'it did not finish' }),
      isError: true,
    },
  ];
}

async function seedMessage(
  chatId: string,
  callParts: MessagePart[],
  options: { isGenerating?: boolean; checkpoint?: boolean } = {}
): Promise<{ messageId: string; checkpoint: TurnCheckpointPart; text: string }> {
  const messageId = crypto.randomUUID();
  const checkpoint: TurnCheckpointPart = {
    ...createTurnCheckpointPart({
      turnId: messageId,
      startedAt: Date.now(),
      provider: 'openai',
      modelName: 'gpt-test',
      agentId: 'default',
    }),
    status: 'completed',
  };
  const text = 'I tried to read the notes.';
  const parts: MessagePart[] = [
    ...(options.checkpoint === false ? [] : [checkpoint]),
    { type: 'text', text },
    ...callParts,
  ];
  await insertMessage(
    {
      id: messageId,
      chatId,
      role: 'ai',
      text,
      timestamp: Date.now(),
      isGenerating: options.isGenerating ?? false,
      generationTime: '1.5s',
      modelName: 'gpt-test',
      interactionMode: 'agent',
      parts: JSON.stringify(parts),
    },
    getDb()
  );
  return { messageId, checkpoint, text };
}

function retryRequest(
  chatId: string,
  messageId: string,
  callId: string,
  body: Record<string, unknown> = {}
) {
  return new Request(
    `http://localhost/chats/${chatId}/messages/${messageId}/tool-calls/${callId}/retry`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function appFor() {
  const { app, restore } = createAuthenticatedApiTestApp(testUser, toolCallRetryRoutes);
  restoreAuth = restore;
  return app;
}

async function readMessage(messageId: string) {
  const row = await getDb()
    .selectFrom('messages')
    .select(['text', 'parts', 'isGenerating', 'generationTime', 'modelName'])
    .where('id', '=', messageId)
    .executeTakeFirstOrThrow();
  return { ...row, parts: JSON.parse(row.parts ?? '[]') as MessagePart[] };
}

function toolCallsOf(parts: MessagePart[]) {
  return parts.filter(
    (part): part is Extract<MessagePart, { type: 'tool_call' }> => part.type === 'tool_call'
  );
}

describe('POST /chats/:id/messages/:messageId/tool-calls/:callId/retry refusals', () => {
  it('requires authentication', async () => {
    const app = createApiTestApp(toolCallRetryRoutes);

    const response = await app.handle(retryRequest('chat', 'message', 'call'));

    expect(response.status).toBe(401);
  });

  it('answers 404 for a chat the user does not own', async () => {
    const stranger = await insertTestUser();
    const chat = await insertTestChat(stranger.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', READ_TOOL, { status: 'timed_out', reasonCode: 'timeout' })
    );

    const response = await appFor().handle(retryRequest(chat.id, messageId, 'call-1'));

    expect(response.status).toBe(404);
  });

  it('answers 404 for a message that is not in the chat', async () => {
    const chat = await insertTestChat(testUser.id);

    const response = await appFor().handle(retryRequest(chat.id, 'no-such-message', 'call-1'));

    expect(response.status).toBe(404);
  });

  it('answers 404 for a call the message does not hold', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', READ_TOOL, { status: 'timed_out', reasonCode: 'timeout' })
    );

    const response = await appFor().handle(retryRequest(chat.id, messageId, 'no-such-call'));

    expect(response.status).toBe(404);
  });

  it('answers 409 while another message in the chat is generating, and runs nothing', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', READ_TOOL, { status: 'timed_out', reasonCode: 'timeout' })
    );
    await seedMessage(chat.id, [], { isGenerating: true });

    const response = await appFor().handle(retryRequest(chat.id, messageId, 'call-1'));

    expect(response.status).toBe(409);
    expect(toolRuns).toEqual([]);
    expect((await readMessage(messageId)).isGenerating).toBe(0);
  });

  it('answers 409 for a call that succeeded', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(chat.id, [
      ...endedCall('call-1', READ_TOOL, { status: 'succeeded' }),
    ]);

    const response = await appFor().handle(retryRequest(chat.id, messageId, 'call-1'));

    expect(response.status).toBe(409);
    expect(toolRuns).toEqual([]);
  });

  it.each(['not_allowed', 'tool_disabled', 'unknown_tool', 'validation_failed'] as const)(
    'answers 409 for a call policy refused (%s): the same call would be refused again',
    async (reasonCode) => {
      const chat = await insertTestChat(testUser.id);
      const { messageId } = await seedMessage(
        chat.id,
        endedCall('call-1', READ_TOOL, { status: 'failed', reasonCode })
      );

      const response = await appFor().handle(retryRequest(chat.id, messageId, 'call-1'));

      expect(response.status).toBe(409);
      expect(toolRuns).toEqual([]);
    }
  );

  it('answers 409 for a tool a tool-only run cannot finish', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', 'ask_user_question', { status: 'failed', reasonCode: 'execution_error' })
    );

    const response = await appFor().handle(retryRequest(chat.id, messageId, 'call-1'));

    expect(response.status).toBe(409);
  });

  it('answers 409 for a tool the agent no longer allows', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', 'retired_fixture_tool', {
        status: 'failed',
        reasonCode: 'execution_error',
      })
    );

    const response = await appFor().handle(
      retryRequest(chat.id, messageId, 'call-1', { confirmed: true })
    );

    expect(response.status).toBe(409);
    expect(toolRuns).toEqual([]);
  });

  it('answers 409 for a message that recorded no turn', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', READ_TOOL, { status: 'timed_out', reasonCode: 'timeout' }),
      { checkpoint: false }
    );

    const response = await appFor().handle(retryRequest(chat.id, messageId, 'call-1'));

    expect(response.status).toBe(409);
  });

  it('answers 400 for a policy that asks first when the request is not confirmed, and leaves the message alone', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall(
        'call-1',
        WRITE_TOOL,
        { status: 'failed', reasonCode: 'execution_error' },
        { path: 'notes.md', content: 'new' }
      )
    );
    const before = await readMessage(messageId);

    const response = await appFor().handle(retryRequest(chat.id, messageId, 'call-1'));

    expect(response.status).toBe(400);
    expect(toolRuns).toEqual([]);
    expect(await readMessage(messageId)).toEqual(before);
  });

  it('asks even a read to confirm when its outcome is unknown', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', READ_TOOL, { status: 'cancelled', reasonCode: 'outcome_unknown' })
    );

    const response = await appFor().handle(retryRequest(chat.id, messageId, 'call-1'));

    expect(response.status).toBe(400);
    expect(toolRuns).toEqual([]);
  });
});

describe('POST /chats/:id/messages/:messageId/tool-calls/:callId/retry run', () => {
  it('runs a read directly as a new call linked to the original, which stays as it ended', async () => {
    const chat = await insertTestChat(testUser.id);
    const originalParts = endedCall(
      'call-1',
      READ_TOOL,
      { status: 'timed_out', reasonCode: 'timeout', timeoutMs: 30_000 },
      { path: 'notes.md' }
    );
    const { messageId, checkpoint, text } = await seedMessage(chat.id, originalParts);

    const response = await appFor().handle(retryRequest(chat.id, messageId, 'call-1'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const events = parseSseEvents(await response.text());
    expect(events[0]).toMatchObject({ type: 'assistant_message_id', messageId });
    expect(events.at(-1)).toMatchObject({ type: 'done', done: true, messageId });

    expect(toolRuns).toEqual([{ name: READ_TOOL, args: { path: 'notes.md' } }]);
    const message = await readMessage(messageId);
    expect(message.isGenerating).toBe(0);
    expect(message.text).toBe(text);
    expect(message.generationTime).toBe('1.5s');
    expect(message.modelName).toBe('gpt-test');

    const calls = toolCallsOf(message.parts);
    expect(calls).toHaveLength(2);
    // The original is byte-for-byte what it was.
    expect(message.parts).toContainEqual(originalParts[0]);
    expect(message.parts).toContainEqual(originalParts[1]);
    // The new call is its own lifecycle, linked and attributed.
    const retried = calls.find((call) => call.retryOf === 'call-1');
    if (retried === undefined) throw new Error('expected a call with retryOf "call-1"');
    expect(retried).toMatchObject({
      name: READ_TOOL,
      args: { path: 'notes.md' },
      retryOf: 'call-1',
      initiatedBy: 'user',
      execution: { status: 'succeeded', source: 'builtin', retrySafety: 'safe_read' },
    });
    expect(retried.toolCallId).not.toBe('call-1');
    expect(message.parts).toContainEqual({
      type: 'tool_result',
      toolCallId: retried.toolCallId,
      content: expect.stringContaining('"ok":true'),
      isError: false,
    });
    // The checkpoint the original turn left is not rewritten by the retry.
    expect(message.parts.find(isTurnCheckpointPart)).toEqual(checkpoint);

    // The model-facing lifecycle events carry the new call's id.
    const transitions = events
      .filter((event) => event.type === 'tool_execution' && event.callId === retried.toolCallId)
      .map((event) => (event.execution as ToolExecutionSnapshot).status);
    expect(transitions).toEqual(['queued', 'running', 'succeeded']);
    expect(isActiveTurn(messageId)).toBe(false);
  });

  it('runs a write after the user confirmed it', async () => {
    const chat = await insertTestChat(testUser.id);
    const args = { path: 'notes.md', content: 'new' };
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', WRITE_TOOL, { status: 'failed', reasonCode: 'execution_error' }, args)
    );

    const response = await appFor().handle(
      retryRequest(chat.id, messageId, 'call-1', { confirmed: true })
    );

    expect(response.status).toBe(200);
    expect(parseSseEvents(await response.text()).at(-1)).toMatchObject({ type: 'done' });
    expect(toolRuns).toEqual([{ name: WRITE_TOOL, args }]);
    const calls = toolCallsOf((await readMessage(messageId)).parts);
    expect(calls[1]).toMatchObject({
      retryOf: 'call-1',
      initiatedBy: 'user',
      execution: { status: 'succeeded', retrySafety: 'confirmation_required' },
    });
  });

  it('keeps the new call as a failure, not a rewrite of the original, when the tool throws again', async () => {
    const chat = await insertTestChat(testUser.id);
    await mockToolsModule([
      makeRegisteredTool(READ_TOOL, 'always fails', () => Promise.reject(new Error('disk gone'))),
    ]);
    const originalParts = endedCall('call-1', READ_TOOL, {
      status: 'timed_out',
      reasonCode: 'timeout',
    });
    const { messageId } = await seedMessage(chat.id, originalParts);

    // This fixture declares nothing, so it takes the default: ask first.
    const response = await appFor().handle(
      retryRequest(chat.id, messageId, 'call-1', { confirmed: true })
    );

    expect(response.status).toBe(200);
    expect(parseSseEvents(await response.text()).at(-1)).toMatchObject({ type: 'done' });
    const message = await readMessage(messageId);
    expect(message.isGenerating).toBe(0);
    const calls = toolCallsOf(message.parts);
    expect(message.parts).toContainEqual(originalParts[0]);
    expect(calls[1]).toMatchObject({
      retryOf: 'call-1',
      initiatedBy: 'user',
      execution: { status: 'failed', reasonCode: 'execution_error' },
    });
  });

  it('offers no second retry of a call that was already retried', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', READ_TOOL, { status: 'timed_out', reasonCode: 'timeout' })
    );
    const app = appFor();
    await (await app.handle(retryRequest(chat.id, messageId, 'call-1'))).text();

    const second = await app.handle(retryRequest(chat.id, messageId, 'call-1'));

    expect(second.status).toBe(409);
    expect(toolRuns).toHaveLength(1);
  });

  it('refuses a second retry in the chat while the first is still running', async () => {
    const chat = await insertTestChat(testUser.id);
    const first = await seedMessage(
      chat.id,
      endedCall('call-1', BLOCKING_TOOL, { status: 'timed_out', reasonCode: 'timeout' })
    );
    const second = await seedMessage(
      chat.id,
      endedCall('call-2', READ_TOOL, { status: 'timed_out', reasonCode: 'timeout' })
    );
    const app = appFor();

    const running = await app.handle(retryRequest(chat.id, first.messageId, 'call-1'));
    expect(running.status).toBe(200);
    // The stream starts the tool as it is read.
    const body = running.text();
    await blockingToolEntered;

    expect(isActiveTurn(first.messageId)).toBe(true);
    expect((await readMessage(first.messageId)).isGenerating).toBe(1);
    const refused = await app.handle(retryRequest(chat.id, second.messageId, 'call-2'));
    expect(refused.status).toBe(409);
    expect(toolRuns.map((run) => run.name)).toEqual([BLOCKING_TOOL]);

    releaseBlockingTool?.();
    expect(parseSseEvents(await body).at(-1)).toMatchObject({ type: 'done' });
    expect((await readMessage(first.messageId)).isGenerating).toBe(0);
    expect(isActiveTurn(first.messageId)).toBe(false);
  });
});

describe('concurrent retries of one message', () => {
  it('keeps the winner registered and cancellable, and refuses the loser', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', BLOCKING_TOOL, { status: 'timed_out', reasonCode: 'timeout' })
    );
    const app = appFor();

    const responses = await Promise.all([
      app.handle(retryRequest(chat.id, messageId, 'call-1')),
      app.handle(retryRequest(chat.id, messageId, 'call-1')),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.status === 200);
    if (winner === undefined) throw new Error('expected one retry to win with status 200');
    const body = winner.text();
    await blockingToolEntered;

    // The loser's cleanup ran; the winner must still be the registered turn.
    expect(isActiveTurn(messageId)).toBe(true);
    expect(cancelActiveTurn(messageId, testUser.id, chat.id, 'user_cancelled')).toBe(true);
    releaseBlockingTool?.();
    await body;
    expect(isActiveTurn(messageId)).toBe(false);
    expect(toolRuns).toHaveLength(1);
  });
});

describe('a retry interrupted by a crash', () => {
  it('does not offer to continue the original turn, and seals the new call', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId, checkpoint } = await seedMessage(
      chat.id,
      endedCall('call-1', BLOCKING_TOOL, { status: 'timed_out', reasonCode: 'timeout' })
    );
    const running = await appFor().handle(retryRequest(chat.id, messageId, 'call-1'));
    const body = running.text();
    await blockingToolEntered;

    // What the boot sweep does to a row left generating by a dead process.
    const swept = await interruptCheckpointedMessage(
      { messageId, reasonCode: 'server_restart' },
      getDb()
    );

    expect(swept).toBe(true);
    const message = await readMessage(messageId);
    expect(message.isGenerating).toBe(0);
    // An `interrupted` checkpoint is what makes the chat offer "continue interrupted turn".
    expect(message.parts.find(isTurnCheckpointPart)).toEqual(checkpoint);
    const retried = toolCallsOf(message.parts).find((call) => call.retryOf === 'call-1');
    expect(retried?.execution?.status).not.toBe('running');

    releaseBlockingTool?.();
    await body;
  });

  it('is already marked when the message is reopened, before any tool work', async () => {
    const chat = await insertTestChat(testUser.id);
    const { messageId } = await seedMessage(
      chat.id,
      endedCall('call-1', READ_TOOL, { status: 'timed_out', reasonCode: 'timeout' })
    );

    await reserveToolCallRetry(
      {
        chatId: chat.id,
        messageId,
        callId: 'call-1',
        userId: testUser.id,
        confirmed: true,
        onTurnReserved: () => {},
      },
      getDb()
    );
    await interruptCheckpointedMessage({ messageId, reasonCode: 'server_restart' }, getDb());

    const message = await readMessage(messageId);
    expect(message.isGenerating).toBe(0);
    expect(message.parts.find(isTurnCheckpointPart)?.status).toBe('completed');
    expect(toolRuns).toEqual([]);
  });
});
