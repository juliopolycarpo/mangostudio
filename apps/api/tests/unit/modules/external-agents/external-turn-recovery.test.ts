import { beforeEach, describe, expect, it } from 'bun:test';
import type {
  ExternalApprovalPart,
  ExternalTurnPart,
  MessagePart,
} from '@mangostudio/shared/types';
import { getDb } from '../../../../src/db/database';
import type { ExternalTurnAttemptState } from '../../../../src/db/types';
import {
  reconcileExternalTurns,
  sealOrphanedExternalTurnAttempts,
} from '../../../../src/modules/external-agents/application/external-turn-recovery';
import {
  insertAttempt,
  listAttemptsForMessage,
  transitionAttempt,
} from '../../../../src/modules/external-agents/infrastructure/external-turn-attempt-repository';
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

  it('clears a row recorded terminal before its final update landed', async () => {
    const messageId = await insertGeneratingMessage([
      { ...ACTIVE_TURN_PART, status: 'terminal', terminalReason: 'cancelled-by-user' },
    ]);

    await expect(
      reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb())
    ).resolves.toBe(1);
    const stored = await readParts(messageId);
    // The flag goes; the reason the turn actually ended for stays.
    expect(stored.generating).toBe(false);
    expect(stored.parts[0]).toMatchObject({ terminalReason: 'cancelled-by-user' });
  });

  describe('(f) submission receipts at boot', () => {
    async function withAttempt(state: ExternalTurnAttemptState): Promise<string> {
      const messageId = await insertGeneratingMessage([{ ...ACTIVE_TURN_PART }]);
      const id = `attempt-${crypto.randomUUID()}`;
      await insertAttempt(
        {
          id,
          messageId,
          chatId,
          userId,
          environmentId: 'local',
          sessionId: 'session-1',
          clientMessageId: 'client-1',
          inputFingerprint: 'sha256:0',
          createdAt: 1,
          updatedAt: 1,
        },
        getDb()
      );
      if (state !== 'acceptance-unknown') {
        await transitionAttempt(id, ['acceptance-unknown'], state, { at: 2 }, getDb());
      }
      return messageId;
    }

    async function outcome(messageId: string) {
      const stored = await readParts(messageId);
      const attempts = await listAttemptsForMessage(messageId, getDb());
      return {
        reason: (stored.parts[0] as ExternalTurnPart).terminalReason,
        attempts: attempts.map((row) => row.state),
      };
    }

    it('ends a turn whose submission was never confirmed as acceptance-unknown', async () => {
      const messageId = await withAttempt('acceptance-unknown');
      await reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb());
      expect(await outcome(messageId)).toEqual({
        reason: 'acceptance-unknown',
        attempts: ['unresolved'],
      });
    });

    it('ends a turn whose submission was already unresolved as acceptance-unknown', async () => {
      const messageId = await withAttempt('unresolved');
      await reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb());
      expect(await outcome(messageId)).toEqual({
        reason: 'acceptance-unknown',
        attempts: ['unresolved'],
      });
    });

    it('keeps hub-restarted for an accepted turn', async () => {
      const messageId = await withAttempt('accepted');
      await reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb());
      expect(await outcome(messageId)).toEqual({ reason: 'hub-restarted', attempts: ['terminal'] });
    });

    it('seals a not-submitted turn without replaying it', async () => {
      const messageId = await withAttempt('not-submitted');
      await reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb());
      expect(await outcome(messageId)).toEqual({ reason: 'hub-restarted', attempts: ['terminal'] });
    });

    it("lets a user's own cancel keep its reason", async () => {
      const messageId = await withAttempt('acceptance-unknown');
      await reconcileExternalTurns({ reason: 'cancelled-by-user', messageId }, getDb());
      expect(await outcome(messageId)).toEqual({
        reason: 'cancelled-by-user',
        attempts: ['unresolved'],
      });
    });

    it('seals receipts left open under a turn that already finished', async () => {
      const messageId = await withAttempt('accepted');
      await getDb()
        .updateTable('messages')
        .set({
          isGenerating: 0,
          parts: JSON.stringify([
            { ...ACTIVE_TURN_PART, status: 'terminal', terminalReason: 'completed' },
          ]),
        })
        .where('id', '=', messageId)
        .execute();
      const unconfirmed = await withAttempt('acceptance-unknown');
      await getDb()
        .updateTable('messages')
        .set({ isGenerating: 0 })
        .where('id', '=', unconfirmed)
        .execute();

      await sealOrphanedExternalTurnAttempts(getDb());

      const rows = [
        ...(await listAttemptsForMessage(messageId, getDb())),
        ...(await listAttemptsForMessage(unconfirmed, getDb())),
      ];
      expect(rows.map((row) => [row.state, row.terminalReason])).toEqual([
        ['terminal', 'completed'],
        ['unresolved', 'hub-restarted'],
      ]);
    });

    it('leaves the receipts of a still-generating turn to the message sweep', async () => {
      const messageId = await withAttempt('acceptance-unknown');
      await sealOrphanedExternalTurnAttempts(getDb());
      expect((await listAttemptsForMessage(messageId, getDb())).map((row) => row.state)).toEqual([
        'acceptance-unknown',
      ]);
    });

    it('is idempotent', async () => {
      const messageId = await withAttempt('accepted');
      await reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb());
      await reconcileExternalTurns({ reason: 'hub-restarted', chatId }, getDb());
      expect(await outcome(messageId)).toEqual({ reason: 'hub-restarted', attempts: ['terminal'] });
    });
  });
});
