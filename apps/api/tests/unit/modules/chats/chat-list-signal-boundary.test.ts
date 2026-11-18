/**
 * Where the chat list's signal may come from.
 *
 * `chats.updatedAt` orders the chat list, so whoever moves it owes every other
 * tab a `chats` frame. That used to be a convention each writer remembered; now
 * the code that writes the column sends the frame, and this test keeps it so.
 * It walks the real source tree, like `runtime-module-allow-list.test.ts`,
 * because a fifth writer added later fails here instead of passing review
 * silently.
 *
 * Two rules:
 *
 * 1. Only `conversation-persistence.ts` writes `chats.updatedAt` after creation,
 *    and it announces from the same file (`updateChatAfterTurn`, and
 *    `persistImageTurn` after its commit). Behavior of each path is pinned by
 *    `conversation-persistence-chat-list-signal.test.ts`.
 * 2. Only four files may publish a `chats` frame: that persistence point, the
 *    chat create use case (a new row, no `updatedAt` move), the chat update
 *    use case (list-visible fields that do not touch `updatedAt`), and the chat
 *    delete use case (a row that is gone, no `updatedAt` move). A caller of the
 *    persistence point that also publishes would send two frames.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const API_SRC = resolve(import.meta.dir, '../../../../src');

const PERSISTENCE_POINT = 'modules/generation/infrastructure/conversation-persistence.ts';
const PUBLISHER_DEFINITION = 'services/realtime/chat-list-invalidation.ts';

const ALLOWED_PUBLISHERS: ReadonlySet<string> = new Set([
  PERSISTENCE_POINT,
  'modules/chats/application/create-chat.ts',
  'modules/chats/application/update-chat.ts',
  'modules/chats/application/delete-chat.ts',
]);

/** `updateTable('chats')` followed, before the statement ends, by a `.set({ ... updatedAt ... })`. */
const CHATS_UPDATED_AT_WRITE = /updateTable\(\s*'chats'\s*\)\s*\.set\(\s*\{[^}]*\bupdatedAt\b/;

const PUBLISH_CALL = /\bpublishChatListInvalidation\s*\(/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => join(directory, entry))
    .filter((path) => statSync(path).isFile());
}

/** Source with comment lines dropped, so prose naming a call is not a call. */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

function filesMatching(pattern: RegExp): string[] {
  return sourceFiles(API_SRC)
    .filter((path) => pattern.test(codeOnly(path)))
    .map((path) => relative(API_SRC, path).replaceAll('\\', '/'))
    .sort();
}

describe('chat list signal boundary', () => {
  it('lets only the persistence point write chats.updatedAt', () => {
    const writers = filesMatching(CHATS_UPDATED_AT_WRITE);

    expect(
      writers,
      `(chats.updatedAt writers): expected only ${PERSISTENCE_POINT} | received: ${writers.join(', ')}. Route the write through updateChatAfterTurn so the chats frame goes out with it.`
    ).toEqual([PERSISTENCE_POINT]);
  });

  it('lets only the persistence point and the chat create, update and delete use cases publish a chats frame', () => {
    const publishers = filesMatching(PUBLISH_CALL).filter((file) => file !== PUBLISHER_DEFINITION);
    const unexpected = publishers.filter((file) => !ALLOWED_PUBLISHERS.has(file));

    expect(
      unexpected,
      `(publishChatListInvalidation callers): expected a subset of ${[...ALLOWED_PUBLISHERS].join(', ')} | received: ${unexpected.join(', ')}. A caller of updateChatAfterTurn must not publish as well, or the tab gets two frames.`
    ).toEqual([]);
    expect(publishers, 'the persistence point must publish').toContain(PERSISTENCE_POINT);
  });

  it('detects a chats.updatedAt write the scan is meant to forbid', () => {
    // Guards the pattern itself: a regex that silently stops matching would pass
    // both rules above on any tree.
    const offending = `await db
      .updateTable('chats')
      .set({ updatedAt: input.timestamp })
      .where('id', '=', input.chatId)
      .execute();`;
    const benign = `await db.updateTable('chats').set({ lastProviderState: null }).execute();`;

    expect(CHATS_UPDATED_AT_WRITE.test(offending)).toBe(true);
    expect(CHATS_UPDATED_AT_WRITE.test(benign)).toBe(false);
  });
});
