/**
 * The staged-checkpoint budget of one assistant message (issue #762). A revert
 * uploads every large blob of the message before it writes a file, and the
 * runtime's staging area is bounded, so capture stops accepting large files
 * once the message holds as much as one revert can stage. Blobs here are sparse
 * files: the budget reads sizes from directory entries, so a gigabyte of
 * checkpoints costs no disk.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RemoteError } from '@mangostudio/protocol';
import {
  SNAPSHOT_INLINE_MAX_BYTES,
  SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS,
  SNAPSHOT_MESSAGE_STAGED_MAX_BYTES,
} from '@mangostudio/shared/runtime-contract';
import { fixtures } from '@mangostudio/shared/test-utils';

import { getDb } from '../../../../src/db/database';
import { getConfig } from '../../../../src/lib/config';
import { messageStagedUsage } from '../../../../src/modules/file-checkpoints/application/staged-capture-limit';
import { insertCheckpointRow } from '../../../../src/modules/file-checkpoints/infrastructure/checkpoint-repository';
import { getRuntimeConnectionManager } from '../../../../src/services/runtime-client/runtime-connection-manager';
import { executeMoveFile } from '../../../../src/services/tools/builtin/move-file';
import { snapshotCaptureParams } from '../../../../src/services/tools/file-mutation-snapshot';
import type { ToolContext } from '../../../../src/services/tools/types';
import { type ChatFixture, insertTestChat, type UserFixture } from '../../../support/factories';
import { insertUserWithLocalRuntime } from '../../../support/fixtures/local-runtime-user';
import { LocalRuntimeLossWatch } from '../../../support/local-runtime-loss-watch';
import { removeFixtureDirSync } from '../../../support/remove-fixture-dir';
import { explainStagedSnapshotSupport } from '../../../support/staged-snapshot-probe';

const MIB = 1024 * 1024;

let tempDir: string;
let chat: ChatFixture;
let messageId: string;
let user: UserFixture;
let sparseBlobPaths: string[];

// Recording before the connect, so the log also holds how this connection began.
const lossWatch = new LocalRuntimeLossWatch();

beforeAll(async () => {
  lossWatch.start();
  user = await insertUserWithLocalRuntime();
});

afterAll(() => {
  lossWatch.stop();
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'message-checkpoint-budget-test-'));
  sparseBlobPaths = [];
  chat = await insertTestChat(user.id);
  messageId = fixtures.uuid();
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

afterEach(async () => {
  removeFixtureDirSync({ role: 'message-checkpoint-budget', path: tempDir });
  await Promise.all(sparseBlobPaths.map((path) => rm(path, { force: true })));
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

/** Why the Local runtime does or does not stage snapshots, for an assertion message. */
function stagingExplanation(): Promise<string> {
  return explainStagedSnapshotSupport(getRuntimeConnectionManager(), chat.userId, 'local').then(
    (staging) => `${staging} | ${lossWatch.explain()}`
  );
}

/** Records an edit whose before-content is a `size`-byte blob, without writing its bytes. */
async function recordSparseCheckpoint(size: number): Promise<void> {
  const blobKey = createHash('sha256').update(randomUUID()).digest('hex');
  const path = join(getConfig().checkpoints.dir, blobKey.slice(0, 2), blobKey);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w');
  await handle.truncate(size);
  await handle.close();
  sparseBlobPaths.push(path);
  await insertCheckpointRow(getDb(), {
    chatId: chat.id,
    messageId,
    environmentId: 'local',
    path: join(tempDir, `${blobKey}.bin`),
    op: 'edit',
    beforeHash: blobKey,
    afterHash: 'a'.repeat(64),
    movedTo: null,
    blobKey,
  });
}

describe('snapshotCaptureParams against a message budget', () => {
  it('sends the configured limit for a message with no large checkpoints', async () => {
    expect(await snapshotCaptureParams(turnContext()), await stagingExplanation()).toEqual({
      captureSnapshot: true,
      snapshotMaxBytes: getConfig().checkpoints.maxFileBytes,
    });
  });

  it('shrinks the limit to the bytes the message has left', async () => {
    const left = 40 * MIB;
    await recordSparseCheckpoint(SNAPSHOT_MESSAGE_STAGED_MAX_BYTES - left);

    expect(await snapshotCaptureParams(turnContext()), await stagingExplanation()).toEqual({
      captureSnapshot: true,
      snapshotMaxBytes: left,
    });
  });

  it('limits a message that holds the whole byte budget to inline-size files', async () => {
    await recordSparseCheckpoint(SNAPSHOT_MESSAGE_STAGED_MAX_BYTES);

    expect(await snapshotCaptureParams(turnContext()), await stagingExplanation()).toEqual({
      captureSnapshot: true,
      snapshotMaxBytes: SNAPSHOT_INLINE_MAX_BYTES,
    });
  });

  it('limits a message that holds the most blobs allowed to inline-size files', async () => {
    for (let count = 0; count < SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS; count += 1) {
      await recordSparseCheckpoint(2 * MIB);
    }

    expect(await messageStagedUsage(getDb(), chat.id, messageId)).toEqual({
      blobs: SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS,
      bytes: SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS * 2 * MIB,
    });
    expect(await snapshotCaptureParams(turnContext()), await stagingExplanation()).toEqual({
      captureSnapshot: true,
      snapshotMaxBytes: SNAPSHOT_INLINE_MAX_BYTES,
    });
  });

  it('does not count inline-size checkpoints against the budget', async () => {
    for (let count = 0; count < SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS + 8; count += 1) {
      await recordSparseCheckpoint(SNAPSHOT_INLINE_MAX_BYTES);
    }

    expect(await messageStagedUsage(getDb(), chat.id, messageId)).toEqual({ blobs: 0, bytes: 0 });
    expect(await snapshotCaptureParams(turnContext()), await stagingExplanation()).toEqual({
      captureSnapshot: true,
      snapshotMaxBytes: getConfig().checkpoints.maxFileBytes,
    });
  });

  it('keeps another message of the same chat out of the count', async () => {
    await recordSparseCheckpoint(SNAPSHOT_MESSAGE_STAGED_MAX_BYTES);
    const otherMessageId = fixtures.uuid();

    expect(
      await messageStagedUsage(getDb(), chat.id, otherMessageId),
      `expected no staged usage for a message with no checkpoints | message: ${otherMessageId}`
    ).toEqual({ blobs: 0, bytes: 0 });
  });
});

describe('a large file once the message budget is spent', () => {
  it('is refused before it moves, and a file of inline size still is checkpointed', async () => {
    await recordSparseCheckpoint(SNAPSHOT_MESSAGE_STAGED_MAX_BYTES);
    const big = join(tempDir, 'big.bin');
    const bigMoved = join(tempDir, 'big-moved.bin');
    const size = 2 * MIB;
    await writeFile(big, Buffer.alloc(size, 7));

    const error = await executeMoveFile({ from: big, to: bigMoved }, turnContext()).then(
      () => null,
      (reason: unknown) => reason
    );

    const explanation = `received: ${String(error)} | ${await stagingExplanation()}`;
    expect(error, explanation).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).details, explanation).toMatchObject({
      kind: 'snapshot_too_large',
      sizeBytes: size,
      limitBytes: SNAPSHOT_INLINE_MAX_BYTES,
    });
    expect(statSync(big).size).toBe(size);
    expect(existsSync(bigMoved)).toBe(false);

    const small = join(tempDir, 'small.bin');
    const smallMoved = join(tempDir, 'small-moved.bin');
    await writeFile(small, Buffer.alloc(64 * 1024, 3));
    await lossWatch.explaining(() =>
      executeMoveFile({ from: small, to: smallMoved }, turnContext())
    );
    expect(existsSync(smallMoved)).toBe(true);
  });
});
