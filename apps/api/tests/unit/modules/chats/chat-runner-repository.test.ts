import { describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  deleteChat,
  getById,
  getOwnedChat,
  RunnerKindImmutableError,
  updateChat,
} from '../../../../src/modules/chats/infrastructure/chat-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

async function insertMessage(chatId: string): Promise<void> {
  await getDb()
    .insertInto('messages')
    .values({
      id: `msg-${chatId}`,
      chatId,
      role: 'user',
      text: 'first turn',
      timestamp: Date.now(),
      isGenerating: 0,
      interactionMode: 'agent',
    })
    .execute();
}

describe('chat runner mapping', () => {
  it('round-trips a mangostudio runner through the flat columns', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);

    await updateChat(
      chat.id,
      user.id,
      { runner: { kind: 'mangostudio', agentId: 'explore' } },
      getDb()
    );

    expect((await getById(chat.id, getDb()))?.runner).toEqual({
      kind: 'mangostudio',
      agentId: 'explore',
    });
  });

  it('normalizes an agent id that no longer resolves rather than throwing', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await getDb()
      .updateTable('chats')
      .set({ runnerAgentId: 'not-an-agent-id' })
      .where('id', '=', chat.id)
      .execute();

    expect((await getById(chat.id, getDb()))?.runner).toEqual({
      kind: 'mangostudio',
      agentId: 'default',
    });
  });

  it('throws on a row whose kind and companion column cannot both be true', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await getDb()
      .updateTable('chats')
      .set({ runnerAgentId: null })
      .where('id', '=', chat.id)
      .execute();

    expect(getById(chat.id, getDb())).rejects.toThrow(/corrupt runner configuration/);
  });

  it('exposes the runner to the generation turn path', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await updateChat(
      chat.id,
      user.id,
      { runner: { kind: 'mangostudio', agentId: 'explore' } },
      getDb()
    );

    const owned = await getOwnedChat(chat.id, user.id, getDb());

    expect(owned?.runner).toEqual({ kind: 'mangostudio', agentId: 'explore' });
  });
});

describe('D14 runner kind immutability', () => {
  it('allows changing the agent within the mangostudio kind after a turn exists', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await insertMessage(chat.id);

    await updateChat(
      chat.id,
      user.id,
      { runner: { kind: 'mangostudio', agentId: 'explore' } },
      getDb()
    );

    expect((await getById(chat.id, getDb()))?.runner).toEqual({
      kind: 'mangostudio',
      agentId: 'explore',
    });
  });

  it('rejects a kind change once the chat has a persisted turn', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await insertMessage(chat.id);

    expect(
      updateChat(chat.id, user.id, { runner: { kind: 'external', targetId: 'codex' } }, getDb())
    ).rejects.toBeInstanceOf(RunnerKindImmutableError);

    expect((await getById(chat.id, getDb()))?.runner).toEqual({
      kind: 'mangostudio',
      agentId: 'default',
    });
  });

  it('allows a kind change while the chat has no turns', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);

    await updateChat(
      chat.id,
      user.id,
      { runner: { kind: 'external', targetId: 'codex' } },
      getDb()
    );

    expect((await getById(chat.id, getDb()))?.runner).toEqual({
      kind: 'external',
      targetId: 'codex',
    });
  });

  it('leaves the rest of the update unapplied when the kind change is rejected', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await insertMessage(chat.id);

    expect(
      updateChat(
        chat.id,
        user.id,
        { title: 'renamed', runner: { kind: 'external', targetId: 'codex' } },
        getDb()
      )
    ).rejects.toBeInstanceOf(RunnerKindImmutableError);

    // The guard and the write share one transaction, so a rejected runner
    // change must not leak the sibling column updates it travelled with.
    expect((await getById(chat.id, getDb()))?.title).toBe(chat.title);
  });
});

describe('external session continuation ownership', () => {
  it('reaps the server-owned continuation row when its chat is deleted', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await getDb()
      .insertInto('external_session_continuations')
      .values({
        chatId: chat.id,
        userId: user.id,
        environmentId: 'local',
        targetId: 'codex',
        canonicalWorkspacePath: '/srv/projects/mango',
        vendorAccountFingerprint: null,
        runtimeSessionId: 'runtime-session-1',
        nativeSessionId: 'native-session-1',
        effectiveConfiguration: null,
        updatedAt: Date.now(),
      })
      .execute();

    await deleteChat(chat.id, user.id, getDb());

    // The cascade is what keeps chat deletion from needing a second code path
    // to forget a vendor session it opened.
    const remaining = await getDb()
      .selectFrom('external_session_continuations')
      .select('chatId')
      .where('chatId', '=', chat.id)
      .executeTakeFirst();
    expect(remaining).toBeUndefined();
  });
});
