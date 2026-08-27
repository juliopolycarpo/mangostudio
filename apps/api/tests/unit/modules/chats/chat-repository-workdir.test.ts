import { describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  listChatIdsByWorkdir,
  listChatIdsUnderWorktreeRoot,
} from '../../../../src/modules/chats/infrastructure/chat-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

async function bindChat(chatId: string, environmentId: string, workdir: string | null) {
  await getDb()
    .updateTable('chats')
    .set({ environmentId, workdir })
    .where('id', '=', chatId)
    .execute();
}

describe('listChatIdsByWorkdir', () => {
  it('returns every chat of one user on one machine and workdir, and nothing else', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();

    const first = await insertTestChat(owner.id);
    const second = await insertTestChat(owner.id);
    const otherWorkdir = await insertTestChat(owner.id);
    const otherMachine = await insertTestChat(owner.id);
    const unbound = await insertTestChat(owner.id);
    const foreign = await insertTestChat(other.id);

    await bindChat(first.id, 'devbox', '/repo');
    await bindChat(second.id, 'devbox', '/repo');
    await bindChat(otherWorkdir.id, 'devbox', '/elsewhere');
    await bindChat(otherMachine.id, 'laptop', '/repo');
    await bindChat(unbound.id, 'devbox', null);
    await bindChat(foreign.id, 'devbox', '/repo');

    const ids = await listChatIdsByWorkdir(owner.id, 'devbox', '/repo', getDb());

    expect([...ids].sort()).toEqual([first.id, second.id].sort());
  });
});

describe('listChatIdsUnderWorktreeRoot', () => {
  it('returns chats bound to the root and to subdirectories of it, on one machine (#944)', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();

    const atRoot = await insertTestChat(owner.id);
    const subdir = await insertTestChat(owner.id);
    const deeperSubdir = await insertTestChat(owner.id);
    const siblingDir = await insertTestChat(owner.id);
    const otherMachine = await insertTestChat(owner.id);
    const unbound = await insertTestChat(owner.id);
    const foreign = await insertTestChat(other.id);

    await bindChat(atRoot.id, 'devbox', '/repo');
    await bindChat(subdir.id, 'devbox', '/repo/apps/api');
    await bindChat(deeperSubdir.id, 'devbox', '/repo/apps/api/src');
    await bindChat(siblingDir.id, 'devbox', '/repo-other');
    await bindChat(otherMachine.id, 'laptop', '/repo/apps/api');
    await bindChat(unbound.id, 'devbox', null);
    await bindChat(foreign.id, 'devbox', '/repo/apps/api');

    const ids = await listChatIdsUnderWorktreeRoot(owner.id, 'devbox', '/repo', getDb());

    expect([...ids].sort()).toEqual([atRoot.id, subdir.id, deeperSubdir.id].sort());
  });
});
