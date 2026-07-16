import { describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { isTurnCheckpointPart, type TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import { getDb } from '../../../../src/db/database';
import {
  CHECKPOINT_MAX_INTERVAL_MS,
  CHECKPOINT_TEXT_INTERVAL_CHARS,
  classifyToolRetrySafety,
  createTurnCheckpointPart,
  refreshTurnCheckpointPart,
  TurnCheckpointWriter,
} from '../../../../src/modules/generation/application/turn-checkpoint';
import {
  buildRecoveryPrompt,
  inspectInterruptedTurnResume,
  reconcileStaleTurns,
  reserveInterruptedTurnResume,
  TurnRecoveryConflictError,
} from '../../../../src/modules/generation/application/turn-recovery';
import {
  finalizeCheckpointedAiResponse,
  persistTextTurnStart,
} from '../../../../src/modules/generation/infrastructure/conversation-persistence';
import { insertMessage } from '../../../../src/modules/messages/infrastructure/message-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

function checkpoint(turnId: string, status: TurnCheckpointPart['status'] = 'active') {
  return {
    ...createTurnCheckpointPart({
      turnId,
      startedAt: 1_000,
      provider: 'openai',
      modelName: 'gpt-test',
      agentId: 'chat',
    }),
    status,
    ...(status === 'interrupted' ? { reasonCode: 'server_restart' as const } : {}),
  };
}

async function createOwnedChat() {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  return { user, chat };
}

describe('turn checkpoints', () => {
  it('throttles text checkpoints while forcing durable boundaries', async () => {
    const { chat } = await createOwnedChat();
    const turnId = crypto.randomUUID();
    const part = checkpoint(turnId);
    const parts: MessagePart[] = [part];
    let text = '';
    let now = part.startedAt;

    await insertMessage(
      {
        id: turnId,
        chatId: chat.id,
        role: 'ai',
        text,
        timestamp: Date.now(),
        isGenerating: true,
        interactionMode: 'chat',
        parts: JSON.stringify(parts),
      },
      getDb()
    );

    const writer = new TurnCheckpointWriter({
      db: getDb(),
      chatId: chat.id,
      messageId: turnId,
      checkpoint: part,
      getContent: () => ({ text, parts, providerState: null }),
      now: () => now,
    });

    text = 'x'.repeat(CHECKPOINT_TEXT_INTERVAL_CHARS - 1);
    now += CHECKPOINT_MAX_INTERVAL_MS - 1;
    expect(await writer.checkpoint()).toBe(false);

    text += 'x';
    expect(await writer.checkpoint()).toBe(true);
    expect(part.sequence).toBe(1);

    text += 'y';
    expect(await writer.checkpoint({ force: true })).toBe(true);
    expect(part.sequence).toBe(2);

    const row = await getDb()
      .selectFrom('messages')
      .select(['text', 'parts'])
      .where('id', '=', turnId)
      .executeTakeFirstOrThrow();
    expect(row.text).toBe(text);
    expect(
      (JSON.parse(row.parts ?? '[]') as MessagePart[]).find(isTurnCheckpointPart)?.sequence
    ).toBe(2);
  });

  it('bounds durable text, tool results, and call counts', () => {
    const part = checkpoint('bounded-turn');
    const parts: MessagePart[] = [part];
    for (let index = 0; index < 60; index++) {
      parts.push({
        type: 'tool_call',
        toolCallId: `call-${index}`,
        name: 'read_file',
        args: {},
      });
      parts.push({
        type: 'tool_result',
        toolCallId: `call-${index}`,
        content: 'r'.repeat(3_000),
      });
    }

    refreshTurnCheckpointPart(
      part,
      { text: 't'.repeat(10_000), parts, providerState: null },
      2_000,
      { force: true }
    );

    expect(part.lastAssistantText).toHaveLength(8_000);
    expect(part.completedCalls).toHaveLength(50);
    expect(part.completedCalls[0]?.result).toHaveLength(2_000);
  });

  it('classifies read-only, mutating, delegated, and MCP calls conservatively', () => {
    expect(classifyToolRetrySafety('read_file')).toBe('safe_read');
    expect(classifyToolRetrySafety('grep')).toBe('safe_read');
    expect(classifyToolRetrySafety('write_file')).toBe('confirmation_required');
    expect(classifyToolRetrySafety('run_shell')).toBe('confirmation_required');
    expect(classifyToolRetrySafety('delegate_to_agent')).toBe('unknown');
    expect(classifyToolRetrySafety('mcp__github__create_issue')).toBe('unknown');
  });
});

describe('interrupted turn recovery', () => {
  it('reconciles stale execution and elicitation state without claiming unknown mutations failed', async () => {
    const { chat } = await createOwnedChat();
    const messageId = crypto.randomUUID();
    const part = checkpoint(messageId);
    const parts: MessagePart[] = [
      part,
      {
        type: 'tool_call',
        toolCallId: 'read-1',
        name: 'read_file',
        args: {},
        execution: { status: 'running', source: 'builtin', queuedAt: 1, startedAt: 2 },
      },
      {
        type: 'tool_call',
        toolCallId: 'write-1',
        name: 'write_file',
        args: {},
        execution: { status: 'running', source: 'builtin', queuedAt: 1, startedAt: 2 },
      },
      {
        type: 'mcp_elicitation',
        elicitationId: 'elicit-1',
        toolCallId: 'mcp-1',
        serverSlug: 'github',
        message: 'Confirm',
        fields: [],
        status: 'pending',
      },
    ];
    await insertMessage(
      {
        id: messageId,
        chatId: chat.id,
        role: 'ai',
        text: 'durable text',
        timestamp: Date.now(),
        isGenerating: true,
        interactionMode: 'chat',
        parts: JSON.stringify(parts),
      },
      getDb()
    );

    expect(
      await reconcileStaleTurns(
        { chatId: chat.id, reasonCode: 'server_restart', isActive: () => false },
        getDb()
      )
    ).toBe(1);

    const row = await getDb()
      .selectFrom('messages')
      .select(['isGenerating', 'parts'])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    const reconciled = JSON.parse(row.parts ?? '[]') as MessagePart[];
    const reconciledCheckpoint = reconciled.find(isTurnCheckpointPart);
    const readCall = reconciled.find(
      (item) => item.type === 'tool_call' && item.toolCallId === 'read-1'
    );
    const writeCall = reconciled.find(
      (item) => item.type === 'tool_call' && item.toolCallId === 'write-1'
    );
    const elicitation = reconciled.find((item) => item.type === 'mcp_elicitation');

    expect(row.isGenerating).toBe(0);
    expect(reconciledCheckpoint).toMatchObject({
      status: 'interrupted',
      reasonCode: 'server_restart',
    });
    expect(readCall?.type === 'tool_call' && readCall.execution?.reasonCode).toBe('turn_aborted');
    expect(writeCall?.type === 'tool_call' && writeCall.execution?.reasonCode).toBe(
      'outcome_unknown'
    );
    expect(elicitation?.type === 'mcp_elicitation' && elicitation.status).toBe('cancelled');
    // Every tool call must carry a result once persisted: providers reject a
    // replayed call with no matching output, which would break later turns.
    for (const callId of ['read-1', 'write-1']) {
      const sealed = reconciled.find(
        (item) => item.type === 'tool_result' && item.toolCallId === callId
      );
      expect(sealed?.type === 'tool_result' && sealed.isError).toBe(true);
    }
    expect(reconciledCheckpoint?.incompleteCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callId: 'read-1', outcome: 'interrupted' }),
        expect.objectContaining({ callId: 'write-1', outcome: 'unknown' }),
      ])
    );
  });

  it('builds a closed, size-bounded prompt with explicit retry selection', () => {
    const part = checkpoint('prompt-turn', 'interrupted');
    part.lastAssistantText = 'a'.repeat(8_000);
    part.completedCalls = Array.from({ length: 50 }, (_, index) => ({
      callId: `done-${index}`,
      name: 'read_file',
      retrySafety: 'safe_read' as const,
      result: 'r'.repeat(2_000),
    }));
    part.incompleteCalls = [
      {
        callId: 'retry-read',
        name: 'read_file',
        retrySafety: 'safe_read',
        status: 'cancelled',
        outcome: 'interrupted',
      },
      {
        callId: 'retry-write',
        name: 'write_file',
        retrySafety: 'confirmation_required',
        status: 'cancelled',
        outcome: 'unknown',
      },
    ];

    const prompt = buildRecoveryPrompt(part, ['retry-read']);
    const json = prompt.split('<turn-recovery>\n')[1]?.split('\n</turn-recovery>')[0];

    expect(prompt.length).toBeLessThanOrEqual(16_000);
    expect(prompt.endsWith('</turn-recovery>')).toBe(true);
    expect(JSON.parse(json ?? '{}')).toMatchObject({
      interruptedTurnId: 'prompt-turn',
      selectedRetryCallIds: ['retry-read'],
    });
  });

  it('clears stale rows that carry no checkpoint instead of leaving them generating', async () => {
    const { chat } = await createOwnedChat();
    const legacyId = crypto.randomUUID();
    await insertMessage(
      {
        id: legacyId,
        chatId: chat.id,
        role: 'ai',
        text: 'written before turn recovery existed',
        timestamp: Date.now(),
        isGenerating: true,
        interactionMode: 'chat',
      },
      getDb()
    );

    expect(
      await reconcileStaleTurns({ chatId: chat.id, reasonCode: 'server_restart' }, getDb())
    ).toBe(1);

    const row = await getDb()
      .selectFrom('messages')
      .select(['isGenerating', 'parts'])
      .where('id', '=', legacyId)
      .executeTakeFirstOrThrow();
    expect(row.isGenerating).toBe(0);
    // Nothing to seal and no checkpoint to record, so parts stay untouched.
    expect(row.parts).toBeNull();
  });

  it('finalizes the original assistant row once', async () => {
    const { user, chat } = await createOwnedChat();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const part = checkpoint(assistantMessageId);
    await persistTextTurnStart(
      {
        userId: user.id,
        userMessageId,
        assistantMessageId,
        chatId: chat.id,
        displayPrompt: 'hello',
        timestamp: Date.now(),
        interactionMode: 'chat',
        modelName: 'gpt-test',
        assistantParts: [part],
      },
      getDb()
    );

    part.status = 'completed';
    expect(
      await finalizeCheckpointedAiResponse(
        {
          id: assistantMessageId,
          userId: user.id,
          chatId: chat.id,
          text: 'first result',
          parts: [part, { type: 'text', text: 'first result' }],
          generationTime: '1ms',
          modelName: 'gpt-test',
        },
        getDb()
      )
    ).toBe(true);
    expect(
      await finalizeCheckpointedAiResponse(
        {
          id: assistantMessageId,
          userId: user.id,
          chatId: chat.id,
          text: 'duplicate result',
          parts: [part],
          generationTime: '2ms',
          modelName: 'gpt-test',
        },
        getDb()
      )
    ).toBe(false);

    const messages = await getDb()
      .selectFrom('messages')
      .select(['id', 'text'])
      .where('chatId', '=', chat.id)
      .execute();
    expect(messages).toHaveLength(2);
    expect(messages.find((message) => message.id === assistantMessageId)?.text).toBe(
      'first result'
    );
  });

  it('reserves one continuation, links attachments, and rejects a repeated resume', async () => {
    const { user, chat } = await createOwnedChat();
    const sourceMessageId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const sourceCheckpoint = checkpoint(sourceMessageId, 'interrupted');
    await getDb()
      .insertInto('chat_attachments')
      .values({
        id: attachmentId,
        userId: user.id,
        chatId: chat.id,
        messageId: null,
        originalName: 'recovery.txt',
        storedName: `${attachmentId}-recovery.txt`,
        relativePath: `${chat.id}/${attachmentId}-recovery.txt`,
        url: `/uploads/${chat.id}/${attachmentId}-recovery.txt`,
        mimeType: 'text/plain',
        sizeBytes: 8,
        kind: 'text',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .execute();
    await insertMessage(
      {
        id: sourceMessageId,
        chatId: chat.id,
        role: 'ai',
        text: 'partial',
        timestamp: Date.now(),
        isGenerating: false,
        interactionMode: 'chat',
        modelName: 'gpt-test',
        parts: JSON.stringify([sourceCheckpoint]),
      },
      getDb()
    );
    const recovery = {
      messageId: sourceMessageId,
      requestId: crypto.randomUUID(),
      retryCallIds: [],
    };
    const inspected = await inspectInterruptedTurnResume(
      { chatId: chat.id, userId: user.id, recovery },
      getDb()
    );

    const reserved = await reserveInterruptedTurnResume(
      {
        chatId: chat.id,
        userId: user.id,
        displayPrompt: 'continue',
        attachmentIds: [attachmentId],
        recovery,
        inspected,
        resolvedModel: { modelId: 'gpt-test', providerType: 'openai' },
        agentId: 'chat',
      },
      getDb()
    );

    await expect(
      inspectInterruptedTurnResume({ chatId: chat.id, userId: user.id, recovery }, getDb())
    ).rejects.toBeInstanceOf(TurnRecoveryConflictError);
    const rows = await getDb()
      .selectFrom('messages')
      .select('id')
      .where('chatId', '=', chat.id)
      .execute();
    expect(rows).toHaveLength(3);
    const linkedAttachment = await getDb()
      .selectFrom('chat_attachments')
      .select('messageId')
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow();
    expect(linkedAttachment.messageId).toBe(reserved.userMessageId);
  });
});
