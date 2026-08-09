/**
 * A chat's external session only survives while the binding that justified it
 * does. The vendor is part of that binding, and the repository lets a chat be
 * repointed at another vendor even after it has messages.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { ExternalAgentConfiguration } from '@mangostudio/shared/external-agents';
import { getDb } from '../../../../src/db/database';
import { updateChatUseCase } from '../../../../src/modules/chats/application/update-chat';
import {
  readContinuation,
  writeContinuation,
} from '../../../../src/modules/external-agents/infrastructure/external-session-continuation-repository';
import { insertTestUser } from '../../../support/factories';

const CONFIGURATION: ExternalAgentConfiguration = {
  level: 'default',
  routing: 'user',
  workspaceRoots: ['/work/repo'],
};

let userId = '';
let chatId = '';

async function insertExternalChat(): Promise<void> {
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

  await writeContinuation(
    {
      userId,
      chatId,
      environmentId: 'local',
      targetId: 'codex',
      canonicalWorkspacePath: '/work/repo',
      vendorAccountFingerprint: 'account-a',
      runtimeSessionId: 'session-1',
      nativeSessionId: 'native-session-1',
      effectiveConfiguration: CONFIGURATION,
      updatedAt: Date.now(),
    },
    getDb()
  );
}

beforeEach(async () => {
  const user = await insertTestUser();
  userId = user.id;
  chatId = `chat-${crypto.randomUUID()}`;
  await insertExternalChat();
});

describe('external session invalidation on chat update', () => {
  it('drops the vendor conversation when the chat is repointed at another vendor', async () => {
    await updateChatUseCase(
      { chatId, userId, updates: { runner: { kind: 'external', targetId: 'claude' } } },
      getDb()
    );

    // Kept, the next send would resume one vendor's conversation under another
    // vendor's binding, and a live turn would write its output into a chat that
    // is no longer its own.
    await expect(readContinuation(chatId, getDb())).resolves.toBeUndefined();
    // And the update itself lands: the runner write runs under the transaction
    // the use case already opened rather than trying to begin a second one.
    const row = await getDb()
      .selectFrom('chats')
      .select('runnerTargetId')
      .where('id', '=', chatId)
      .executeTakeFirstOrThrow();
    expect(row.runnerTargetId).toBe('claude');
  });

  it('keeps it when the update changes nothing the session is bound to', async () => {
    await updateChatUseCase({ chatId, userId, updates: { title: 'renamed' } }, getDb());

    await expect(readContinuation(chatId, getDb())).resolves.toMatchObject({
      chatId,
      nativeSessionId: 'native-session-1',
    });
  });
});
