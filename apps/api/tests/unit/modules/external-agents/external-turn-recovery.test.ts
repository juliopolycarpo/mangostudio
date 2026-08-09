import { beforeEach, describe, expect, it } from 'bun:test';
import type {
  ExternalApprovalPart,
  ExternalTurnPart,
  MessagePart,
} from '@mangostudio/shared/types';
import { getDb } from '../../../../src/db/database';
import { reconcileExternalTurns } from '../../../../src/modules/external-agents/application/external-turn-recovery';
import { insertTestUser } from '../../../support/factories';

let userId = '';
let chatId = '';

const ACTIVE_TURN_PART: ExternalTurnPart = {
  type: 'external_turn',
  version: 1,
  targetId: 'codex',
  sessionId: 'session-1',
  nativeTurnId: 'native-turn-1',
  status: 'active',
  startedAt: 1_000,
  updatedAt: 1_500,
  lastSequence: 4,
  eventCount: 4,
  persistedBytes: 128,
};

const PENDING_APPROVAL_PART: ExternalApprovalPart = {
  type: 'external_approval',
  targetId: 'codex',
  requestId: 'req-1',
  kind: 'command',
  title: 'Run the migration',
  options: [{ id: 'approve', isDestructive: false }],
  expiresAtMs: 9_999,
};

async function insertGeneratingMessage(parts: MessagePart[]): Promise<string> {
  const id = `message-${crypto.randomUUID()}`;
  await getDb()
    .insertInto('messages')
    .values({
      id,
      chatId,
      role: 'ai',
      text: 'partial answer',
      timestamp: Date.now(),
      isGenerating: 1,
      interactionMode: 'agent',
      parts: JSON.stringify(parts),
    })
    .execute();
  return id;
}

async function readParts(id: string): Promise<{ parts: MessagePart[]; generating: boolean }> {
  const row = await getDb()
    .selectFrom('messages')
    .select(['parts', 'isGenerating'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return {
    parts: row.parts ? (JSON.parse(row.parts) as MessagePart[]) : [],
    generating: row.isGenerating === 1,
  };
}

beforeEach(async () => {
  const user = await insertTestUser();
  userId = user.id;
  chatId = `chat-${crypto.randomUUID()}`;
  await getDb()
    .insertInto('chats')
    .values({
      id: chatId,
      title: 'external chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId,
      runnerKind: 'external',
      runnerTargetId: 'codex',
      workdir: '/work/repo',
      environmentId: 'local',
    })
    .execute();
});

describe('external turn recovery', () => {
  it('terminates an orphaned external turn and records why', async () => {
    const messageId = await insertGeneratingMessage([
      { ...ACTIVE_TURN_PART },
      { type: 'text', text: 'partial answer' },
    ]);

    await expect(
      reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb())
    ).resolves.toBe(1);

    const stored = await readParts(messageId);
    expect(stored.generating).toBe(false);
    expect(stored.parts[0]).toMatchObject({
      type: 'external_turn',
      status: 'terminal',
      terminalReason: 'hub-restarted',
    });
    // The partial transcript survives: it is what the vendor actually said.
    expect(stored.parts[1]).toEqual({ type: 'text', text: 'partial answer' });
  });

  it('seals an approval nobody will ever answer', async () => {
    const messageId = await insertGeneratingMessage([
      { ...ACTIVE_TURN_PART },
      { ...PENDING_APPROVAL_PART },
    ]);

    await reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb());

    const approval = (await readParts(messageId)).parts.find(
      (part): part is ExternalApprovalPart => part.type === 'external_approval'
    );
    expect(approval).toMatchObject({ decisionSource: 'expired' });
    expect(approval?.decision).toBeUndefined();
  });

  it('leaves a live turn alone', async () => {
    const messageId = await insertGeneratingMessage([{ ...ACTIVE_TURN_PART }]);

    await expect(
      reconcileExternalTurns(
        { reason: 'hub-restarted', chatId, isActive: (id) => id === messageId },
        getDb()
      )
    ).resolves.toBe(0);
    expect((await readParts(messageId)).generating).toBe(true);
  });

  it('leaves an internal turn to the generic sweep', async () => {
    const messageId = await insertGeneratingMessage([{ type: 'text', text: 'internal' }]);

    await expect(
      reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb())
    ).resolves.toBe(0);
    expect((await readParts(messageId)).generating).toBe(true);
  });

  it('does not rewrite a turn that already reached a terminal state', async () => {
    const messageId = await insertGeneratingMessage([
      { ...ACTIVE_TURN_PART, status: 'terminal', terminalReason: 'cancelled-by-user' },
    ]);

    await expect(
      reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb())
    ).resolves.toBe(0);
    const stored = await readParts(messageId);
    expect(stored.parts[0]).toMatchObject({ terminalReason: 'cancelled-by-user' });
  });
});
