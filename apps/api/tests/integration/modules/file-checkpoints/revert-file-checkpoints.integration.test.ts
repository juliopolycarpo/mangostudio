/**
 * End-to-end coverage for the per-message file checkpoint manifest: builtin
 * mutations snapshot themselves, and reverting a message replays those rows
 * backwards to restore the pre-turn filesystem state.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { PathAccessError, RuntimeRemoteError } from '@mangostudio/runtime';
import { getDb } from '../../../../src/db/database';
import { deleteChatUseCase } from '../../../../src/modules/chats/application/delete-chat';
import { listChatFileCheckpointSummaries } from '../../../../src/modules/file-checkpoints/application/list-chat-checkpoints';
import {
  FileCheckpointConflictError,
  revertMessageFileCheckpoints,
} from '../../../../src/modules/file-checkpoints/application/revert-message-checkpoints';
import { checkpointBlobSize } from '../../../../src/modules/file-checkpoints/infrastructure/checkpoint-blob-store';
import { executeApplyPatch } from '../../../../src/services/tools/builtin/apply-patch';
import { executeCreateFile } from '../../../../src/services/tools/builtin/create-file';
import { executeDeleteFile } from '../../../../src/services/tools/builtin/delete-file';
import { executeEditFile } from '../../../../src/services/tools/builtin/edit-file';
import { executeMoveFile } from '../../../../src/services/tools/builtin/move-file';
import { executeReadFile } from '../../../../src/services/tools/builtin/read-file';
import { executeWriteFile } from '../../../../src/services/tools/builtin/write-file';
import { clearFileFreshness } from '../../../../src/services/tools/file-freshness';
import type { ToolContext } from '../../../../src/services/tools/types';
import { type ChatFixture, insertTestChat, type UserFixture } from '../../../support/factories';
import { insertUserWithLocalRuntime } from '../../../support/fixtures/local-runtime-user';

let tempDir: string;
let outsideDir: string;
let chat: ChatFixture;
let messageId: string;

// One user, and one Local runtime connection, for the whole file — the
// helper's doc comment carries the rationale.
let user: UserFixture;

beforeAll(async () => {
  user = await insertUserWithLocalRuntime();
});

beforeEach(async () => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'file-checkpoints-test-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'file-checkpoints-outside-'));
  chat = await insertTestChat(user.id);
  messageId = faker.string.uuid();
  await getDb()
    .insertInto('messages')
    .values({
      id: messageId,
      chatId: chat.id,
      role: 'ai',
      text: '',
      imageUrl: null,
      referenceImage: null,
      timestamp: Date.now(),
      isGenerating: 0,
      generationTime: null,
      modelName: null,
      styleParams: null,
      interactionMode: 'chat',
      parts: null,
      providerState: null,
    })
    .execute();
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

/** Turn context as the generation layer builds it: message-scoped, db-backed. */
function turnContext(): ToolContext {
  return {
    userId: chat.userId,
    chatId: chat.id,
    assistantMessageId: messageId,
    db: getDb(),
    workdir: tempDir,
    parameters: {},
  };
}

async function seedAndRead(name: string, content: string): Promise<string> {
  const path = join(tempDir, name);
  await Bun.write(path, content);
  await executeReadFile({ path, maxLines: 5000 }, turnContext());
  return path;
}

function revert() {
  return revertMessageFileCheckpoints(getDb(), chat.id, messageId);
}

async function readText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

describe('revertMessageFileCheckpoints', () => {
  it('reports nothing to revert for a message that touched no files', async () => {
    expect(await revert()).toEqual({ revertedFiles: 0, uncheckpointedSources: [] });
  });

  it('removes a created file', async () => {
    const path = join(tempDir, 'created.txt');
    await executeCreateFile({ path, content: 'hello\n' }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(existsSync(path)).toBe(false);
  });

  it('restores the pre-turn content of an overwritten file', async () => {
    const path = await seedAndRead('notes.md', 'original\n');
    await executeWriteFile({ path, content: 'rewritten\n' }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(await readText(path)).toBe('original\n');
  });

  it('restores a deleted file', async () => {
    const path = await seedAndRead('gone.txt', 'keep me\n');
    await executeDeleteFile({ path }, turnContext());
    expect(existsSync(path)).toBe(false);

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(await readText(path)).toBe('keep me\n');
  });

  it('moves a renamed file back', async () => {
    const from = await seedAndRead('a.ts', 'export const a = 1;\n');
    const to = join(tempDir, 'b.ts');
    await executeMoveFile({ from, to }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(existsSync(to)).toBe(false);
    expect(await readText(from)).toBe('export const a = 1;\n');
  });

  it('collapses repeated mutations of one file into a single revert', async () => {
    const path = await seedAndRead('iterated.txt', 'v1\n');
    await executeWriteFile({ path, content: 'v2\n' }, turnContext());
    await executeWriteFile({ path, content: 'v3\n' }, turnContext());

    const summaries = await listChatFileCheckpointSummaries(getDb(), chat.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.fileCount).toBe(1);

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(await readText(path)).toBe('v1\n');
  });

  it('restores content for a patch that moved and rewrote a file at once', async () => {
    const from = await seedAndRead('src/app.ts', 'const value = 1;\n');
    const to = join(tempDir, 'src/main.ts');
    await executeApplyPatch(
      {
        patch: [
          '*** Begin Patch',
          `*** Update File: ${from}`,
          `*** Move to: ${to}`,
          '@@',
          '-const value = 1;',
          '+const value = 2;',
          '*** End Patch',
        ].join('\n'),
      },
      turnContext()
    );
    expect(await readText(to)).toBe('const value = 2;\n');

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(existsSync(to)).toBe(false);
    expect(await readText(from)).toBe('const value = 1;\n');
  });

  it('reverts a file recreated at a path the same turn moved away from', async () => {
    const from = await seedAndRead('index.ts', 'export * from "./impl";\n');
    const to = join(tempDir, 'impl.ts');
    await executeMoveFile({ from, to }, turnContext());
    await executeCreateFile(
      { path: from, content: 'export const barrel = true;\n' },
      turnContext()
    );

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(existsSync(to)).toBe(false);
    expect(await readText(from)).toBe('export * from "./impl";\n');
  });

  it('reverts a chain of moves through the same intermediate path', async () => {
    const first = await seedAndRead('one.txt', 'chained\n');
    const second = join(tempDir, 'two.txt');
    const third = join(tempDir, 'three.txt');
    await executeMoveFile({ from: first, to: second }, turnContext());
    await executeMoveFile({ from: second, to: third }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 2, uncheckpointedSources: [] });
    expect(existsSync(second)).toBe(false);
    expect(existsSync(third)).toBe(false);
    expect(await readText(first)).toBe('chained\n');
  });

  it('ignores a row whose tool threw before completing the mutation', async () => {
    const path = await seedAndRead('edited.txt', 'alpha\n');
    await expect(
      executeEditFile({ path, oldString: 'nowhere', newString: 'x' }, turnContext())
    ).rejects.toThrow();

    // The failed edit left an open row; it must neither be reverted nor block
    // the file that actually changed.
    const other = join(tempDir, 'created.txt');
    await executeCreateFile({ path: other, content: 'ok\n' }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(await readText(path)).toBe('alpha\n');
    expect(existsSync(other)).toBe(false);
  });

  it('refuses to revert a file changed on disk after the turn', async () => {
    const path = await seedAndRead('notes.md', 'original\n');
    await executeWriteFile({ path, content: 'rewritten\n' }, turnContext());
    await Bun.write(path, 'edited by the user\n');

    await expect(revert()).rejects.toBeInstanceOf(FileCheckpointConflictError);
    expect(await readText(path)).toBe('edited by the user\n');
  });

  it('leaves the message unrevertable a second time', async () => {
    const path = join(tempDir, 'created.txt');
    await executeCreateFile({ path, content: 'hello\n' }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(await revert()).toEqual({ revertedFiles: 0, uncheckpointedSources: [] });
    expect(await listChatFileCheckpointSummaries(getDb(), chat.id)).toEqual([]);
  });
});

/**
 * Reverting restores files and then marks the rows. Nothing makes those two
 * writes one unit, so the bookkeeping half can fail on its own and leave a
 * message that is fully reverted on disk and still listed as revertable.
 * Retrying has to converge on that state instead of reporting the file as
 * changed by someone else.
 */
describe('revert retried after its bookkeeping write did not land', () => {
  /** Exactly what a failed markMessageCheckpointsReverted leaves behind. */
  async function reopenRevertedRows(): Promise<void> {
    await getDb()
      .updateTable('file_checkpoints')
      .set({ revertedAt: null })
      .where('chatId', '=', chat.id)
      .execute();
  }

  async function revertTwice(): Promise<void> {
    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    await reopenRevertedRows();
    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
  }

  it('converges on a restored file', async () => {
    const path = await seedAndRead('notes.md', 'original\n');
    await executeWriteFile({ path, content: 'rewritten\n' }, turnContext());

    await revertTwice();
    expect(await readText(path)).toBe('original\n');
    expect(await listChatFileCheckpointSummaries(getDb(), chat.id)).toEqual([]);
  });

  it('converges on a removed file', async () => {
    const path = join(tempDir, 'created.txt');
    await executeCreateFile({ path, content: 'hello\n' }, turnContext());

    await revertTwice();
    expect(existsSync(path)).toBe(false);
  });

  it('converges on a file moved back', async () => {
    const from = await seedAndRead('a.ts', 'export const a = 1;\n');
    const to = join(tempDir, 'b.ts');
    await executeMoveFile({ from, to }, turnContext());

    await revertTwice();
    expect(existsSync(to)).toBe(false);
    expect(await readText(from)).toBe('export const a = 1;\n');
  });

  it('converges on a chain of moves through the same intermediate path', async () => {
    const first = await seedAndRead('one.txt', 'chained\n');
    const second = join(tempDir, 'two.txt');
    const third = join(tempDir, 'three.txt');
    await executeMoveFile({ from: first, to: second }, turnContext());
    await executeMoveFile({ from: second, to: third }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 2, uncheckpointedSources: [] });
    await reopenRevertedRows();
    // Replaying the operations from here would move the restored file away
    // again; the retry has to recognise its own finished work instead.
    expect(await revert()).toEqual({ revertedFiles: 2, uncheckpointedSources: [] });
    expect(existsSync(second)).toBe(false);
    expect(existsSync(third)).toBe(false);
    expect(await readText(first)).toBe('chained\n');
  });

  it('converges on a file recreated at a path the same turn moved away from', async () => {
    const from = await seedAndRead('index.ts', 'export * from "./impl";\n');
    const to = join(tempDir, 'impl.ts');
    await executeMoveFile({ from, to }, turnContext());
    await executeCreateFile(
      { path: from, content: 'export const barrel = true;\n' },
      turnContext()
    );

    await revertTwice();
    expect(existsSync(to)).toBe(false);
    expect(await readText(from)).toBe('export * from "./impl";\n');
  });

  it('still refuses when the file was changed by someone else after the revert', async () => {
    const path = await seedAndRead('notes.md', 'original\n');
    await executeWriteFile({ path, content: 'rewritten\n' }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    await reopenRevertedRows();
    await Bun.write(path, 'edited by the user\n');

    await expect(revert()).rejects.toBeInstanceOf(FileCheckpointConflictError);
    expect(await readText(path)).toBe('edited by the user\n');
  });
});

/**
 * Restriction is evaluated at revert time, not capture time, so a turn that ran
 * unrestricted can be reverted after the setting is switched on. That is the
 * whole point of re-checking containment here.
 */
describe('revert containment against the chat workdir', () => {
  async function bindWorkdir(restricted: boolean): Promise<void> {
    await getDb()
      .updateTable('chats')
      .set({ workdir: tempDir, restrictToolsToWorkdir: restricted ? 1 : 0 })
      .where('id', '=', chat.id)
      .execute();
  }

  async function pointChatAt(environmentId: string): Promise<void> {
    await getDb().updateTable('chats').set({ environmentId }).where('id', '=', chat.id).execute();
  }

  async function checkpointOutsideWorkdir(): Promise<string> {
    const path = join(outsideDir, 'planted.txt');
    await executeCreateFile({ path, content: 'outside\n' }, turnContext());
    return path;
  }

  it('reverts a path outside the workdir when the chat is unrestricted', async () => {
    await bindWorkdir(false);
    const path = await checkpointOutsideWorkdir();

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a path outside the workdir when the chat is restricted', async () => {
    await bindWorkdir(true);
    const path = await checkpointOutsideWorkdir();

    await expect(revert()).rejects.toBeInstanceOf(PathAccessError);
    // The whole revert is refused, so the file the turn created still stands.
    expect(await readText(path)).toBe('outside\n');
  });

  it('still reverts paths inside the workdir when the chat is restricted', async () => {
    await bindWorkdir(true);
    const path = join(tempDir, 'inside.txt');
    await executeCreateFile({ path, content: 'inside\n' }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(existsSync(path)).toBe(false);
  });

  it('reverts on the environment that recorded the rows, not the one the chat moved to', async () => {
    const path = await seedAndRead('recorded-here.txt', 'original\n');
    await executeWriteFile({ path, content: 'rewritten\n' }, turnContext());
    await pointChatAt('remote-box');

    // Paths and hashes describe the host the turn ran on. Following the chat's
    // new pointer would replay them somewhere they never applied.
    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(await readText(path)).toBe('original\n');
  });

  it('refuses to replay another environment’s checkpoints on the chat’s current one', async () => {
    const path = await seedAndRead('recorded-elsewhere.txt', 'original\n');
    await executeWriteFile({ path, content: 'rewritten\n' }, turnContext());
    await getDb()
      .updateTable('file_checkpoints')
      .set({ environmentId: 'remote-box' })
      .where('chatId', '=', chat.id)
      .execute();

    // 'remote-box' is not a row this user owns, so it cannot be reached — the
    // point is that the local file is left alone rather than restored by a
    // matching hash that belongs to a different host.
    await expect(revert()).rejects.toBeInstanceOf(RuntimeRemoteError);
    expect(await readText(path)).toBe('rewritten\n');
  });
});

describe('checkpoint blob retention', () => {
  it('drops a deleted chat’s blobs once its manifest rows are gone', async () => {
    // Blobs are content-addressed and shared across chats, so this snapshot must
    // be unique to the chat under test for the GC to be observable.
    const path = await seedAndRead('notes.md', `retention ${faker.string.uuid()}\n`);
    await executeWriteFile({ path, content: 'rewritten\n' }, turnContext());

    const row = await getDb()
      .selectFrom('file_checkpoints')
      .select('blobKey')
      .where('chatId', '=', chat.id)
      .executeTakeFirstOrThrow();
    const blobKey = row.blobKey ?? '';
    expect(checkpointBlobSize(blobKey)).toBeGreaterThan(0);

    await deleteChatUseCase({ chatId: chat.id, userId: chat.userId }, getDb());

    expect(checkpointBlobSize(blobKey)).toBe(0);
  });
});
