import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RealtimeInvalidateEvent } from '@mangostudio/shared/realtime';

import { getDb } from '../../../../src/db/database';
import { publishGithubWriteInvalidation } from '../../../../src/modules/github/application/github-realtime-service';
import {
  createRealtimeBus,
  setRealtimeBusForTests,
} from '../../../../src/services/realtime/realtime-bus';
import { insertTestChat, insertTestUser } from '../../../support/factories';

// A junction needs no privilege on Windows, where a directory symlink does; the
// type argument is ignored everywhere else.
const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
const tempDirs: string[] = [];

/** True when the temp volume treats `a` and `A` as one name, as APFS does by default. */
async function detectCaseInsensitiveTmpdir(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), 'mango-case-probe-'));
  try {
    await writeFile(join(probe, 'lower'), '');
    return await stat(join(probe, 'LOWER')).then(
      () => true,
      () => false
    );
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

const caseInsensitiveTmpdir = await detectCaseInsensitiveTmpdir();

afterEach(async () => {
  setRealtimeBusForTests(undefined);
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function bindChat(userId: string, workdir: string): Promise<string> {
  const chat = await insertTestChat(userId);
  await getDb().updateTable('chats').set({ workdir }).where('id', '=', chat.id).execute();
  return chat.id;
}

/**
 * One checkout with a package directory, reached through a symlinked parent. The
 * runtime here is the real Local one, so what resolves is the real filesystem.
 * Nothing about Git is needed: the sibling lookup only asks where a directory is.
 */
async function createFixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'mango-sibling-fanout-')));
  tempDirs.push(parent);
  const checkout = join(parent, 'checkout');
  await mkdir(join(checkout, 'packages', 'ui'), { recursive: true });
  const alias = join(parent, 'alias');
  await symlink(parent, alias, symlinkType);

  const user = await insertTestUser();
  const bus = createRealtimeBus();
  const events: RealtimeInvalidateEvent[] = [];
  bus.subscribe(user.id, (event) => events.push(event));
  setRealtimeBusForTests(bus);
  const writer = await bindChat(user.id, checkout);
  const target = {
    userId: user.id,
    chatId: writer,
    environmentId: 'local',
    workdir: checkout,
  };
  return { parent, checkout, alias, user, events, target };
}

/** The chats that were told, other than the writer. */
function notifiedChats(events: readonly RealtimeInvalidateEvent[], writer: string): string[] {
  return events
    .map((event) => event.topic)
    .filter((topic) => topic.startsWith('git:') && topic !== `git:${writer}`)
    .map((topic) => topic.slice('git:'.length))
    .sort();
}

// The repository-wide frame needs Git and is not what these tests are about.
const NO_REPO_FRAME = {
  repoInvalidation: { resolveRepoKeyForTarget: () => Promise.resolve(undefined) },
};

describe('GitHub write fan-out to sibling chats (#950)', () => {
  it('reaches a sibling bound through a symlinked path to the same workdir', async () => {
    const { alias, user, events, target } = await createFixture();
    const throughSymlink = await bindChat(user.id, join(alias, 'checkout'));
    // A directory that is not there, and one that is a different checkout: neither hears it.
    await bindChat(user.id, join(alias, 'gone'));
    await bindChat(user.id, join(alias, 'checkout-two'));

    await publishGithubWriteInvalidation(target, 'create', NO_REPO_FRAME);

    expect(notifiedChats(events, target.chatId)).toEqual([throughSymlink]);
  });

  it('reaches siblings under the checkout root however they reach it, on a checkout', async () => {
    const { checkout, alias, user, events, target } = await createFixture();
    const atRoot = await bindChat(user.id, join(alias, 'checkout'));
    const underRoot = await bindChat(user.id, join(alias, 'checkout', 'packages', 'ui'));
    const direct = await bindChat(user.id, join(checkout, 'packages'));
    await bindChat(user.id, join(alias, 'checkout-two'));

    await publishGithubWriteInvalidation({ ...target, root: checkout }, 'checkout', NO_REPO_FRAME);

    expect(notifiedChats(events, target.chatId)).toEqual([atRoot, underRoot, direct].sort());
  });

  it.skipIf(!caseInsensitiveTmpdir)('reaches a sibling bound under another casing', async () => {
    const { parent, user, events, target } = await createFixture();
    const differentCase = await bindChat(user.id, join(parent, 'CHECKOUT'));

    await publishGithubWriteInvalidation(target, 'create', NO_REPO_FRAME);

    expect(notifiedChats(events, target.chatId)).toEqual([differentCase]);
  });
});
