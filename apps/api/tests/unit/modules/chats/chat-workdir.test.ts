import { describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  chatAccessDenied,
  chatWorkdirConflict,
  resolveChatWorkdir,
} from '../../../../src/modules/chats/application/chat-workdir';
import { insertTestChat, insertTestUser } from '../../../support/factories';

describe('resolveChatWorkdir', () => {
  it('returns the chat row and workdir when access is allowed', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const workdir = '/tmp/mango-chat-workdir-ok';
    await getDb().updateTable('chats').set({ workdir }).where('id', '=', chat.id).execute();

    const resolution = await resolveChatWorkdir(chat.id, user.id, getDb());

    expect(resolution).toEqual({
      state: 'ok',
      workdir,
      chat: expect.objectContaining({ id: chat.id, userId: user.id, workdir }),
    });
  });

  it('reports not-found, forbidden, and no-workdir without leaking workdir paths', async () => {
    const [owner, other] = await Promise.all([insertTestUser(), insertTestUser()]);
    const chat = await insertTestChat(owner.id);
    const workdir = '/tmp/mango-chat-workdir-hidden';
    await getDb().updateTable('chats').set({ workdir }).where('id', '=', chat.id).execute();

    expect(await resolveChatWorkdir('missing-chat', owner.id, getDb())).toEqual({
      state: 'not-found',
    });
    expect(await resolveChatWorkdir(chat.id, other.id, getDb())).toEqual({ state: 'forbidden' });
    expect(await resolveChatWorkdir(chat.id, owner.id, getDb())).toMatchObject({
      state: 'ok',
      workdir,
    });

    await getDb().updateTable('chats').set({ workdir: null }).where('id', '=', chat.id).execute();
    expect(await resolveChatWorkdir(chat.id, owner.id, getDb())).toEqual({ state: 'no-workdir' });
  });
});

describe('chat access helpers', () => {
  it('maps denied resolutions and missing workdir to API errors', () => {
    const set = { status: 200 as number | string };

    expect(chatAccessDenied({ state: 'not-found' }, set)).toEqual({
      error: 'Chat not found',
      code: 'NOT_FOUND',
    });
    expect(set.status).toBe(404);

    set.status = 200;
    expect(chatAccessDenied({ state: 'forbidden' }, set)).toEqual({
      error: 'Chat belongs to another user',
      code: 'OWNERSHIP',
    });
    expect(set.status).toBe(403);

    set.status = 200;
    expect(chatWorkdirConflict(set)).toEqual({
      error: 'Chat has no working directory',
      code: 'CONFLICT',
    });
    expect(set.status).toBe(409);
  });
});
