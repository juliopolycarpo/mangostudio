/**
 * Partial blob streams a hub left behind (issue #762). A transfer that dies
 * between its first chunk and the rename to the content hash leaves a `.part`
 * file in `.incoming`. No row names it, so retention cannot see it: only a
 * sweep by age removes it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { fixtures } from '@mangostudio/shared/test-utils';

import { getDb } from '../../../../src/db/database';
import { getConfig } from '../../../../src/lib/config';
import {
  INCOMING_STALE_AFTER_MS,
  storeCheckpointBlob,
  storeCheckpointBlobStream,
  sweepStaleIncomingBlobs,
} from '../../../../src/modules/file-checkpoints/infrastructure/checkpoint-blob-store';
import {
  enforceChatRetention,
  insertCheckpointRow,
} from '../../../../src/modules/file-checkpoints/infrastructure/checkpoint-repository';
import { insertTestChat, insertTestUser } from '../../../support/factories';

let incomingDir: string;
let created: string[];

beforeEach(async () => {
  incomingDir = join(getConfig().checkpoints.dir, '.incoming');
  await mkdir(incomingDir, { recursive: true });
  created = [];
});

afterEach(async () => {
  await Promise.all(created.map((path) => rm(path, { force: true })));
});

/** Puts a file in `.incoming` last modified `ageMs` ago. */
async function plantIncoming(name: string, ageMs: number): Promise<string> {
  const path = join(incomingDir, name);
  await writeFile(path, 'partial bytes');
  const modifiedAt = new Date(Date.now() - ageMs);
  await utimes(path, modifiedAt, modifiedAt);
  created.push(path);
  return path;
}

describe('sweepStaleIncomingBlobs', () => {
  it('removes a partial stream untouched past the stale age and keeps a fresh one', async () => {
    const stale = await plantIncoming(`${randomUUID()}.part`, INCOMING_STALE_AFTER_MS + 60_000);
    const fresh = await plantIncoming(`${randomUUID()}.part`, INCOMING_STALE_AFTER_MS / 2);

    const removed = await sweepStaleIncomingBlobs(incomingDir, Date.now());

    expect(existsSync(stale), `expected stale partial removed | path: ${stale}`).toBe(false);
    expect(existsSync(fresh), `expected fresh partial kept | path: ${fresh}`).toBe(true);
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  it('leaves a file that is not a partial stream alone, however old', async () => {
    const other = await plantIncoming(`${randomUUID()}.keep`, 10 * INCOMING_STALE_AFTER_MS);

    await sweepStaleIncomingBlobs(incomingDir, Date.now());

    expect(existsSync(other), `expected non-.part file kept | path: ${other}`).toBe(true);
  });

  it('does nothing when the directory does not exist', async () => {
    expect(await sweepStaleIncomingBlobs(join(incomingDir, 'missing'), Date.now())).toBe(0);
  });
});

describe('a blob stream', () => {
  it('sweeps the partial streams an earlier hub abandoned', async () => {
    const stale = await plantIncoming(`${randomUUID()}.part`, 2 * INCOMING_STALE_AFTER_MS);

    await storeCheckpointBlobStream([new TextEncoder().encode('fresh blob')]);

    expect(existsSync(stale), `expected stale partial removed | path: ${stale}`).toBe(false);
  });

  it('does not remove its own file or a stored blob while sweeping', async () => {
    const blobKey = await storeCheckpointBlob(new TextEncoder().encode(randomUUID()));
    const blobPath = join(getConfig().checkpoints.dir, blobKey.slice(0, 2), blobKey);
    created.push(blobPath);
    const streamed = await storeCheckpointBlobStream([new TextEncoder().encode(randomUUID())]);
    const streamedPath = join(
      getConfig().checkpoints.dir,
      streamed.blobKey.slice(0, 2),
      streamed.blobKey
    );
    created.push(streamedPath);

    expect(existsSync(blobPath)).toBe(true);
    expect(existsSync(streamedPath)).toBe(true);
  });
});

describe('retention', () => {
  it('deletes the blobs it evicts and leaves a partial stream untouched', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const messageId = fixtures.uuid();
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
    // 300 MiB of sparse blob is past the 256 MiB per-chat budget, so retention evicts it.
    const blobKey = randomUUID().replaceAll('-', '').padEnd(64, '0');
    const blobPath = join(getConfig().checkpoints.dir, blobKey.slice(0, 2), blobKey);
    await mkdir(dirname(blobPath), { recursive: true });
    const handle = await open(blobPath, 'w');
    await handle.truncate(300 * 1024 * 1024);
    await handle.close();
    created.push(blobPath);
    await insertCheckpointRow(getDb(), {
      chatId: chat.id,
      messageId,
      environmentId: 'local',
      path: '/work/evicted.bin',
      op: 'edit',
      beforeHash: blobKey,
      afterHash: 'a'.repeat(64),
      movedTo: null,
      blobKey,
    });
    const partial = await plantIncoming(`${randomUUID()}.part`, 10 * INCOMING_STALE_AFTER_MS);

    await enforceChatRetention(getDb(), chat.id);

    expect(existsSync(blobPath), `expected retention to evict the blob | path: ${blobPath}`).toBe(
      false
    );
    expect(existsSync(partial), `expected retention to leave the partial | path: ${partial}`).toBe(
      true
    );
  });
});
