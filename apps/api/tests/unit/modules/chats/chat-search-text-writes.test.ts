import { describe, expect, it } from 'bun:test';

import { getDb } from '../../../../src/db/database';
import {
  createChat,
  listPageByUserId,
  updateChat,
} from '../../../../src/modules/chats/infrastructure/chat-repository';
import { insertTestUser } from '../../../support/factories';

/**
 * `chats.searchText` is what `?q=` looks in, and the database cannot derive it
 * (SQLite folds ASCII only), so every write of the title, the workdir or the
 * runner has to store it again. `createChat` and `updateChat` are the only
 * writers of those columns: the HTTP routes, the external-session adoption and
 * fork, and context compaction all go through them.
 */

async function storedSearchText(chatId: string): Promise<string> {
  const row = await getDb()
    .selectFrom('chats')
    .select('searchText')
    .where('id', '=', chatId)
    .executeTakeFirst();
  if (!row) throw new Error(`(chats): expected a row with id ${chatId} | received: none`);
  return row.searchText;
}

async function foundBy(userId: string, search: string): Promise<string[]> {
  const slice = await listPageByUserId(userId, { limit: 50, search }, getDb());
  return slice.chats.map((chat) => chat.id);
}

describe('chats.searchText write paths', () => {
  it('createChat stores the folded title with the default runner', async () => {
    const owner = await insertTestUser();

    const chat = await createChat({ title: 'Configuração', userId: owner.id }, getDb());

    expect(await storedSearchText(chat.id)).toBe('configuracao\n\nmango');
    expect(await foundBy(owner.id, 'CONFIGURAÇÃO')).toEqual([chat.id]);
  });

  it('a rename replaces the title part and keeps the workdir and runner parts', async () => {
    const owner = await insertTestUser();
    const chat = await createChat({ title: 'Antigo', userId: owner.id }, getDb());
    await updateChat(
      chat.id,
      owner.id,
      { workdir: '/srv/Projetos', runner: { kind: 'external', targetId: 'codex' } },
      getDb()
    );

    await updateChat(chat.id, owner.id, { title: 'Relatório Final' }, getDb());

    expect(await storedSearchText(chat.id)).toBe('relatorio final\nprojetos\ncodex');
    expect(await foundBy(owner.id, 'antigo'), 'the old title must stop matching').toEqual([]);
    expect(await foundBy(owner.id, 'RELATORIO')).toEqual([chat.id]);
  });

  it('a workdir change replaces the folder part, and clearing it empties the part', async () => {
    const owner = await insertTestUser();
    const chat = await createChat({ title: 'Título', userId: owner.id }, getDb());

    await updateChat(chat.id, owner.id, { workdir: '/srv/Pasta Nova/' }, getDb());
    expect(await storedSearchText(chat.id)).toBe('titulo\npasta nova\nmango');

    await updateChat(chat.id, owner.id, { workdir: null }, getDb());
    expect(await storedSearchText(chat.id)).toBe('titulo\n\nmango');
  });

  it('a runner change replaces the label, in both directions', async () => {
    const owner = await insertTestUser();
    const chat = await createChat({ title: 'Runner', userId: owner.id }, getDb());

    await updateChat(
      chat.id,
      owner.id,
      { runner: { kind: 'external', targetId: 'cursor' } },
      getDb()
    );
    expect(await storedSearchText(chat.id)).toBe('runner\n\ncursor');
    expect(await foundBy(owner.id, 'CURSOR')).toEqual([chat.id]);

    await updateChat(
      chat.id,
      owner.id,
      { runner: { kind: 'mangostudio', agentId: 'default' } },
      getDb()
    );
    expect(await storedSearchText(chat.id)).toBe('runner\n\nmango');
    expect(await foundBy(owner.id, 'cursor'), 'the old label must stop matching').toEqual([]);
  });

  it('adopting a native session (create, then bind a vendor and a folder) is searchable at once', async () => {
    const owner = await insertTestUser();

    const chat = await getDb()
      .transaction()
      .execute(async (trx) => {
        const created = await createChat({ title: '', userId: owner.id }, trx);
        await updateChat(
          created.id,
          owner.id,
          { runner: { kind: 'external', targetId: 'codex' }, workdir: '/home/dev/Café' },
          trx
        );
        return created;
      });

    expect(await storedSearchText(chat.id)).toBe('\ncafe\ncodex');
    expect(await foundBy(owner.id, 'CAFÉ')).toEqual([chat.id]);
  });

  it('a change that touches none of the three leaves the text alone', async () => {
    const owner = await insertTestUser();
    const chat = await createChat({ title: 'Estável', userId: owner.id }, getDb());

    await updateChat(chat.id, owner.id, { model: 'gpt-5', textModel: 'gpt-5' }, getDb());

    expect(await storedSearchText(chat.id)).toBe('estavel\n\nmango');
  });

  it("another account's update changes neither the chat nor its text", async () => {
    const owner = await insertTestUser();
    const stranger = await insertTestUser();
    const chat = await createChat({ title: 'Meu', userId: owner.id }, getDb());

    await updateChat(chat.id, stranger.id, { title: 'Roubado' }, getDb());

    expect(await storedSearchText(chat.id)).toBe('meu\n\nmango');
  });
});

describe('listPageByUserId search', () => {
  it('lists everything for a query that is marks alone', async () => {
    const owner = await insertTestUser();
    const chat = await createChat({ title: 'Qualquer', userId: owner.id }, getDb());

    expect(await foundBy(owner.id, '́')).toEqual([chat.id]);
  });
});
