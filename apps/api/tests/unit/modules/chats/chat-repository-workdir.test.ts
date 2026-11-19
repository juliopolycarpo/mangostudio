import { describe, expect, it } from 'bun:test';

import { getDb } from '../../../../src/db/database';
import {
  listOtherChatBindings,
  listOtherChatWorkdirs,
} from '../../../../src/modules/chats/infrastructure/chat-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

async function bindChat(chatId: string, environmentId: string, workdir: string | null) {
  await getDb()
    .updateTable('chats')
    .set({ environmentId, workdir })
    .where('id', '=', chatId)
    .execute();
}

describe('listOtherChatWorkdirs', () => {
  it('returns the stored workdirs of one user on one machine, minus the excluded chat', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();

    const caller = await insertTestChat(owner.id);
    const sibling = await insertTestChat(owner.id);
    const subdir = await insertTestChat(owner.id);
    const otherMachine = await insertTestChat(owner.id);
    const unbound = await insertTestChat(owner.id);
    const foreign = await insertTestChat(other.id);

    await bindChat(caller.id, 'devbox', '/repo');
    await bindChat(sibling.id, 'devbox', '/work/feature/');
    await bindChat(subdir.id, 'devbox', '/work/feature/pkg');
    await bindChat(otherMachine.id, 'laptop', '/work/other');
    await bindChat(unbound.id, 'devbox', null);
    await bindChat(foreign.id, 'devbox', '/work/foreign');

    const workdirs = await listOtherChatWorkdirs(owner.id, 'devbox', caller.id, getDb());

    // Verbatim: comparing them is the target machine's rule, not the database's.
    expect([...workdirs].sort()).toEqual(['/work/feature/', '/work/feature/pkg']);
  });
});

describe('listOtherChatBindings', () => {
  it('returns id and stored workdir for one user on one machine, minus the excluded chat', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();

    const caller = await insertTestChat(owner.id);
    const sibling = await insertTestChat(owner.id);
    const subdir = await insertTestChat(owner.id);
    const otherMachine = await insertTestChat(owner.id);
    const unbound = await insertTestChat(owner.id);
    const foreign = await insertTestChat(other.id);

    await bindChat(caller.id, 'devbox', '/repo');
    await bindChat(sibling.id, 'devbox', '/Repo-Alias/');
    await bindChat(subdir.id, 'devbox', '/repo/pkg');
    await bindChat(otherMachine.id, 'laptop', '/repo');
    await bindChat(unbound.id, 'devbox', null);
    await bindChat(foreign.id, 'devbox', '/repo');

    const bindings = await listOtherChatBindings(owner.id, 'devbox', caller.id, getDb());

    // Verbatim and unfiltered by path: matching is the target machine's rule.
    expect([...bindings].sort((left, right) => left.workdir.localeCompare(right.workdir))).toEqual(
      [
        { chatId: sibling.id, workdir: '/Repo-Alias/' },
        { chatId: subdir.id, workdir: '/repo/pkg' },
      ].sort((left, right) => left.workdir.localeCompare(right.workdir))
    );
  });
});
