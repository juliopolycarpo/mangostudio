/**
 * Durability of the checkpoint half of a file mutation: the manifest row lands
 * under the same per-path lock as the mutation that produced it, and a snapshot
 * that fails its own integrity check degrades the row instead of failing a
 * write that already happened.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import type { RuntimeMutationResult, RuntimeMutationSnapshot } from '@mangostudio/runtime';
import { getDb } from '../../../../src/db/database';
import { revertMessageFileCheckpoints } from '../../../../src/modules/file-checkpoints/application/revert-message-checkpoints';
import { hashCheckpointBytes } from '../../../../src/modules/file-checkpoints/infrastructure/checkpoint-blob-store';
import { executeEditFile } from '../../../../src/services/tools/builtin/edit-file';
import { executeReadFile } from '../../../../src/services/tools/builtin/read-file';
import { executeWriteFile } from '../../../../src/services/tools/builtin/write-file';
import { clearFileFreshness } from '../../../../src/services/tools/file-freshness';
import {
  type FileMutationBeforeFields,
  withMutationPersistence,
} from '../../../../src/services/tools/file-mutation-snapshot';
import type { ToolContext } from '../../../../src/services/tools/types';
import { type ChatFixture, insertTestChat, type UserFixture } from '../../../support/factories';
import { insertUserWithLocalRuntime } from '../../../support/fixtures/local-runtime-user';

let tempDir: string;
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
  tempDir = mkdtempSync(join(tmpdir(), 'checkpoint-durability-test-'));
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

function hashOf(content: string): string {
  return hashCheckpointBytes(Buffer.from(content));
}

async function checkpointRows() {
  return await getDb()
    .selectFrom('file_checkpoints')
    .selectAll()
    .where('chatId', '=', chat.id)
    .orderBy('id', 'asc')
    .execute();
}

/**
 * One mutation as the runtime reports it, without going through a runtime call.
 * The point of these tests is the hub-side window around that call, so the
 * snapshot is handed over directly — including the malformed ones a runtime
 * behind a byte transport can produce but a local one never will.
 */
async function stubMutation(
  path: string,
  before: string,
  after: string,
  overrides: Partial<RuntimeMutationSnapshot['before']> = {}
): Promise<RuntimeMutationResult<{ path: string; sha256: string }>> {
  await Bun.write(path, after);
  return {
    result: { path, sha256: hashOf(after) },
    mutations: [
      {
        path,
        op: 'edit',
        before: {
          exists: true,
          contentBase64: Buffer.from(before).toString('base64'),
          hash: hashOf(before),
          ...overrides,
        },
        afterHash: hashOf(after),
      },
    ],
  };
}

describe('mutation and checkpoint under one lock', () => {
  it('holds the path lock across the runtime call, not just after it', async () => {
    const path = join(tempDir, 'contended.txt');
    await Bun.write(path, 'v1\n');
    const rowsVisibleAtMutationStart: number[] = [];

    const record = async () => {
      rowsVisibleAtMutationStart.push((await checkpointRows()).length);
    };
    // Queued in this order: the lock tail is registered before the first await
    // inside withMutationPersistence, so the second call is deterministically
    // second in line.
    const first = withMutationPersistence(turnContext(), [path], async () => {
      await record();
      return await stubMutation(path, 'v1\n', 'v2\n');
    });
    const second = withMutationPersistence(turnContext(), [path], async () => {
      await record();
      return await stubMutation(path, 'v2\n', 'v3\n');
    });
    await Promise.all([first, second]);

    // The second mutation could not begin until the first one's row existed.
    // With persistence starting only after the runtime call returned, both
    // observe an empty manifest here and race to write it, which is how a row
    // ends up pairing one call's before-state with the other's after-state.
    expect(rowsVisibleAtMutationStart).toEqual([0, 1]);
  });

  it('pairs the first mutation’s before-state with the last one’s after-state', async () => {
    const path = join(tempDir, 'serialized.txt');
    await Bun.write(path, 'v1\n');

    await Promise.all([
      withMutationPersistence(turnContext(), [path], () => stubMutation(path, 'v1\n', 'v2\n')),
      withMutationPersistence(turnContext(), [path], () => stubMutation(path, 'v2\n', 'v3\n')),
    ]);

    const rows = await checkpointRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beforeHash).toBe(hashOf('v1\n'));
    expect(rows[0]?.afterHash).toBe(hashOf('v3\n'));
  });

  it('serialises two edit_file calls on one path within a turn', async () => {
    const path = await seedAndRead('edited.txt', 'one\n');

    // The second edit only matches if the first has already been applied, so a
    // resolved pair of promises is itself part of the assertion.
    await Promise.all([
      executeEditFile({ path, oldString: 'one', newString: 'two' }, turnContext()),
      executeEditFile({ path, oldString: 'two', newString: 'three' }, turnContext()),
    ]);

    expect(await Bun.file(path).text()).toBe('three\n');
    const rows = await checkpointRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beforeHash).toBe(hashOf('one\n'));
    expect(rows[0]?.afterHash).toBe(hashOf('three\n'));
  });

  it('stores an empty snapshot so revert can restore a zero-byte file', async () => {
    const path = await seedAndRead('empty.txt', '');
    const written = await executeWriteFile({ path, content: 'filled\n' }, turnContext());
    expect(written.before).toBe('');
    expect(written.beforeOmitted).toBeUndefined();

    const rows = await checkpointRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beforeHash).toBe(hashOf(''));
    expect(rows[0]?.blobKey).not.toBeNull();

    await revertMessageFileCheckpoints(getDb(), chat.id, messageId);
    expect(await Bun.file(path).text()).toBe('');
  });
});

describe('a snapshot that fails its integrity check', () => {
  /** Diagnostic logs are off for the suite; this turns them on for one call. */
  async function captureDiagnostics(run: () => Promise<void>): Promise<string[]> {
    const previousEnv = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
    const originalError = console.error;
    const lines: string[] = [];
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    console.error = (line: unknown) => lines.push(String(line));
    try {
      await run();
    } finally {
      console.error = originalError;
      if (previousEnv === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
      else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = previousEnv;
    }
    return lines;
  }

  it('records a degraded row and still reports the write that succeeded', async () => {
    const path = join(tempDir, 'corrupt.txt');
    await Bun.write(path, 'v1\n');
    let capturedFields: FileMutationBeforeFields | undefined;

    const logged = await captureDiagnostics(async () => {
      const outcome = await withMutationPersistence(turnContext(), [path], () =>
        stubMutation(path, 'v1\n', 'v2\n', { hash: hashOf('something else\n') })
      );
      // The file changed, so the tool reports the change. Failing here would
      // invite the model to apply the same write a second time.
      expect(outcome.result.sha256).toBe(hashOf('v2\n'));
      capturedFields = outcome.captured[0]?.fields;
    });

    expect(capturedFields).toEqual({ beforeOmitted: 'corrupt' });
    expect(await Bun.file(path).text()).toBe('v2\n');

    const rows = await checkpointRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.afterHash).toBe(hashOf('v2\n'));
    // Nothing was stored, so the row must not claim it has something to restore.
    expect(rows[0]?.beforeHash).toBeNull();
    expect(rows[0]?.blobKey).toBeNull();

    const violation = logged.find((line) =>
      line.includes('checkpoint_snapshot_integrity_violation')
    );
    expect(violation).toBeDefined();
    expect(JSON.parse(violation ?? '{}')).toMatchObject({
      level: 'error',
      metadata: { path, reason: 'hash_mismatch', observedHash: hashOf('v1\n') },
    });
  });

  it('degrades an incomplete snapshot the same way', async () => {
    const path = join(tempDir, 'incomplete.txt');
    await Bun.write(path, 'v1\n');

    await captureDiagnostics(async () => {
      const outcome = await withMutationPersistence(turnContext(), [path], () =>
        stubMutation(path, 'v1\n', 'v2\n', { contentBase64: undefined })
      );
      expect(outcome.captured[0]?.fields).toEqual({ beforeOmitted: 'corrupt' });
    });

    expect((await checkpointRows())[0]?.blobKey).toBeNull();
  });

  it('keeps the corrupt reason when a later mutation collapses onto the same row', async () => {
    const path = join(tempDir, 'collapsed.txt');
    await Bun.write(path, 'v1\n');
    await captureDiagnostics(async () => {
      await withMutationPersistence(turnContext(), [path], () =>
        stubMutation(path, 'v1\n', 'v2\n', { hash: hashOf('something else\n') })
      );
    });

    const second = await withMutationPersistence(turnContext(), [path], () =>
      stubMutation(path, 'v2\n', 'v3\n')
    );
    expect(second.captured[0]?.fields).toEqual({ beforeOmitted: 'corrupt' });
  });

  it('says what it cannot restore when the degraded row is reverted', async () => {
    const path = join(tempDir, 'unrestorable.txt');
    await Bun.write(path, 'v1\n');
    await withMutationPersistence(turnContext(), [path], () =>
      stubMutation(path, 'v1\n', 'v2\n', { hash: hashOf('something else\n') })
    );

    await expect(revertMessageFileCheckpoints(getDb(), chat.id, messageId)).rejects.toThrow(
      /was not captured/
    );
  });
});
