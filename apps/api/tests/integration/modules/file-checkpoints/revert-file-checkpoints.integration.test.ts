/**
 * End-to-end coverage for the per-message file checkpoint manifest: builtin
 * mutations snapshot themselves, and reverting a message replays those rows
 * backwards to restore the pre-turn filesystem state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
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
import { type ChatFixture, insertTestChat, insertTestUser } from '../../../support/factories';

let tempDir: string;
let chat: ChatFixture;
let messageId: string;

beforeEach(async () => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'file-checkpoints-test-'));
  const user = await insertTestUser();
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
    expect(await revert()).toEqual({ revertedFiles: 0 });
  });

  it('removes a created file', async () => {
    const path = join(tempDir, 'created.txt');
    await executeCreateFile({ path, content: 'hello\n' }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 1 });
    expect(existsSync(path)).toBe(false);
  });

  it('restores the pre-turn content of an overwritten file', async () => {
    const path = await seedAndRead('notes.md', 'original\n');
    await executeWriteFile({ path, content: 'rewritten\n' }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 1 });
    expect(await readText(path)).toBe('original\n');
  });

  it('restores a deleted file', async () => {
    const path = await seedAndRead('gone.txt', 'keep me\n');
    await executeDeleteFile({ path }, turnContext());
    expect(existsSync(path)).toBe(false);

    expect(await revert()).toEqual({ revertedFiles: 1 });
    expect(await readText(path)).toBe('keep me\n');
  });

  it('moves a renamed file back', async () => {
    const from = await seedAndRead('a.ts', 'export const a = 1;\n');
    const to = join(tempDir, 'b.ts');
    await executeMoveFile({ from, to }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 1 });
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

    expect(await revert()).toEqual({ revertedFiles: 1 });
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

    expect(await revert()).toEqual({ revertedFiles: 1 });
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

    expect(await revert()).toEqual({ revertedFiles: 1 });
    expect(existsSync(to)).toBe(false);
    expect(await readText(from)).toBe('export * from "./impl";\n');
  });

  it('reverts a chain of moves through the same intermediate path', async () => {
    const first = await seedAndRead('one.txt', 'chained\n');
    const second = join(tempDir, 'two.txt');
    const third = join(tempDir, 'three.txt');
    await executeMoveFile({ from: first, to: second }, turnContext());
    await executeMoveFile({ from: second, to: third }, turnContext());

    expect(await revert()).toEqual({ revertedFiles: 2 });
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

    expect(await revert()).toEqual({ revertedFiles: 1 });
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

    expect(await revert()).toEqual({ revertedFiles: 1 });
    expect(await revert()).toEqual({ revertedFiles: 0 });
    expect(await listChatFileCheckpointSummaries(getDb(), chat.id)).toEqual([]);
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
