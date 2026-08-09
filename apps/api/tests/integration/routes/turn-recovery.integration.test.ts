import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { isTurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import { getDb } from '../../../src/db/database';
import { createTurnCheckpointPart } from '../../../src/modules/generation/application/turn-checkpoint';
import { turnRecoveryRoutes } from '../../../src/modules/generation/http/turn-recovery-routes';
import { insertMessage } from '../../../src/modules/messages/infrastructure/message-repository';
import { insertTestChat, insertTestUser, type UserFixture } from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

let testUser!: UserFixture;
let restoreAuth: (() => void) | null = null;

beforeAll(async () => {
  testUser = await insertTestUser();
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function createCheckpoint(messageId: string) {
  return createTurnCheckpointPart({
    turnId: messageId,
    startedAt: Date.now(),
    provider: 'openai',
    modelName: 'gpt-test',
    agentId: 'default',
  });
}

function recoveryRequest(chatId: string, messageId: string, action: 'cancel' | 'dismiss') {
  return new Request(`http://localhost/chats/${chatId}/messages/${messageId}/recovery/${action}`, {
    method: 'POST',
  });
}

describe('turn recovery routes', () => {
  it('requires authentication', async () => {
    const app = createApiTestApp(turnRecoveryRoutes);

    const response = await app.handle(recoveryRequest('chat-id', 'message-id', 'cancel'));

    expect(response.status).toBe(401);
  });

  it('cancels an active checkpoint without losing durable execution evidence', async () => {
    const chat = await insertTestChat(testUser.id);
    const messageId = crypto.randomUUID();
    const checkpoint = createCheckpoint(messageId);
    const parts: MessagePart[] = [
      checkpoint,
      { type: 'text', text: 'Durable partial answer' },
      {
        type: 'tool_call',
        toolCallId: 'completed-read',
        name: 'read_file',
        args: { path: 'README.md' },
        execution: {
          status: 'succeeded',
          source: 'builtin',
          queuedAt: 1,
          startedAt: 2,
          finishedAt: 3,
        },
      },
      {
        type: 'tool_result',
        toolCallId: 'completed-read',
        content: 'read result',
      },
      {
        type: 'tool_call',
        toolCallId: 'running-write',
        name: 'write_file',
        args: { path: 'notes.md' },
        execution: { status: 'running', source: 'builtin', queuedAt: 4, startedAt: 5 },
      },
      {
        type: 'question',
        toolCallId: 'question-1',
        questions: [
          {
            question: 'Continue with the proposed change?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      {
        type: 'mcp_elicitation',
        elicitationId: 'elicitation-1',
        toolCallId: 'mcp-call-1',
        serverSlug: 'example',
        message: 'Confirm remote action',
        fields: [],
        status: 'pending',
      },
    ];
    await insertMessage(
      {
        id: messageId,
        chatId: chat.id,
        role: 'ai',
        text: 'Durable partial answer',
        timestamp: Date.now(),
        isGenerating: true,
        interactionMode: 'chat',
        parts: JSON.stringify(parts),
      },
      getDb()
    );
    const { app, restore } = createAuthenticatedApiTestApp(testUser, turnRecoveryRoutes);
    restoreAuth = restore;

    const response = await app.handle(recoveryRequest(chat.id, messageId, 'cancel'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messageId, status: 'interrupted' });
    const row = await getDb()
      .selectFrom('messages')
      .select(['text', 'parts', 'isGenerating'])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    const persistedParts = JSON.parse(row.parts ?? '[]') as MessagePart[];
    const persistedCheckpoint = persistedParts.find(isTurnCheckpointPart);

    expect(row).toMatchObject({ text: 'Durable partial answer', isGenerating: 0 });
    expect(persistedCheckpoint).toMatchObject({
      status: 'interrupted',
      reasonCode: 'user_cancelled',
      lastAssistantText: 'Durable partial answer',
      completedCalls: [
        expect.objectContaining({ callId: 'completed-read', result: 'read result' }),
      ],
      incompleteCalls: [
        expect.objectContaining({
          callId: 'running-write',
          retrySafety: 'confirmation_required',
          outcome: 'unknown',
        }),
      ],
    });
    expect(persistedParts).toContainEqual(expect.objectContaining({ type: 'question' }));
    expect(persistedParts).toContainEqual(
      expect.objectContaining({ type: 'mcp_elicitation', status: 'cancelled' })
    );

    const repeatedResponse = await app.handle(recoveryRequest(chat.id, messageId, 'cancel'));
    expect(repeatedResponse.status).toBe(409);
  });

  it('dismisses an interrupted checkpoint once while preserving its evidence', async () => {
    const chat = await insertTestChat(testUser.id);
    const messageId = crypto.randomUUID();
    const checkpoint = createCheckpoint(messageId);
    checkpoint.status = 'interrupted';
    checkpoint.reasonCode = 'server_restart';
    checkpoint.lastAssistantText = 'Recovered after restart';
    const parts: MessagePart[] = [checkpoint, { type: 'text', text: checkpoint.lastAssistantText }];
    await insertMessage(
      {
        id: messageId,
        chatId: chat.id,
        role: 'ai',
        text: checkpoint.lastAssistantText,
        timestamp: Date.now(),
        isGenerating: false,
        interactionMode: 'chat',
        parts: JSON.stringify(parts),
      },
      getDb()
    );
    const { app, restore } = createAuthenticatedApiTestApp(testUser, turnRecoveryRoutes);
    restoreAuth = restore;

    const response = await app.handle(recoveryRequest(chat.id, messageId, 'dismiss'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messageId, status: 'dismissed' });
    const row = await getDb()
      .selectFrom('messages')
      .select(['text', 'parts'])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    const persistedCheckpoint = (JSON.parse(row.parts ?? '[]') as MessagePart[]).find(
      isTurnCheckpointPart
    );
    expect(row.text).toBe('Recovered after restart');
    expect(persistedCheckpoint).toMatchObject({
      status: 'dismissed',
      reasonCode: 'server_restart',
      lastAssistantText: 'Recovered after restart',
    });

    const repeatedResponse = await app.handle(recoveryRequest(chat.id, messageId, 'dismiss'));
    expect(repeatedResponse.status).toBe(409);
  });
});
