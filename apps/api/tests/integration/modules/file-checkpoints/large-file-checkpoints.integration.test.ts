/**
 * Checkpoints of files past what one protocol frame holds (issue #762). The
 * runtime stages such a file and the hub pulls it chunk by chunk into the blob
 * store; a revert streams it back. Moving a file is the one mutation that
 * reaches these sizes, because edit, write and delete first require a complete
 * read, which stops at 10 MiB.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RemoteError } from '@mangostudio/protocol';
import { SNAPSHOT_CHUNK_MAX_BYTES } from '@mangostudio/shared/runtime-contract';
import { fixtures } from '@mangostudio/shared/test-utils';

import { getDb } from '../../../../src/db/database';
import { getConfig } from '../../../../src/lib/config';
import { revertMessageFileCheckpoints } from '../../../../src/modules/file-checkpoints/application/revert-message-checkpoints';
import {
  checkpointBlobSize,
  readCheckpointBlobChunks,
  storeCheckpointBlobStream,
} from '../../../../src/modules/file-checkpoints/infrastructure/checkpoint-blob-store';
import { getRuntimeClient } from '../../../../src/services/runtime-client';
import { executeMoveFile } from '../../../../src/services/tools/builtin/move-file';
import { withMutationPersistence } from '../../../../src/services/tools/file-mutation-snapshot';
import type { ToolContext } from '../../../../src/services/tools/types';
import { type ChatFixture, insertTestChat, type UserFixture } from '../../../support/factories';
import { insertUserWithLocalRuntime } from '../../../support/fixtures/local-runtime-user';
import { removeFixtureDirSync } from '../../../support/remove-fixture-dir';

const MIB = 1024 * 1024;

let tempDir: string;
let chat: ChatFixture;
let messageId: string;
let user: UserFixture;

beforeAll(async () => {
  user = await insertUserWithLocalRuntime();
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'large-file-checkpoints-test-'));
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

afterEach(() => {
  removeFixtureDirSync({ role: 'large-file-checkpoints', path: tempDir });
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

function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Non-repeating bytes, so a dropped or reordered chunk changes the digest. */
function patternBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 131) % 251;
  return bytes;
}

async function checkpointRows() {
  return await getDb()
    .selectFrom('file_checkpoints')
    .selectAll()
    .where('chatId', '=', chat.id)
    .orderBy('id', 'asc')
    .execute();
}

describe('a file past one frame', () => {
  it('is checkpointed on move and restored byte-identical on revert', async () => {
    const from = join(tempDir, 'big.bin');
    const to = join(tempDir, 'big-moved.bin');
    const bytes = patternBytes(20 * MIB + 5);
    await writeFile(from, bytes);

    await executeMoveFile({ from, to }, turnContext());

    expect(existsSync(from)).toBe(false);
    const rows = await checkpointRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.beforeHash).toBe(hashOf(bytes));
    expect(rows[0]?.blobKey).toBe(hashOf(bytes));
    expect(checkpointBlobSize(rows[0]?.blobKey ?? '')).toBe(bytes.length);

    expect(await revertMessageFileCheckpoints(getDb(), chat.id, messageId)).toEqual({
      revertedFiles: 1,
      uncheckpointedSources: [],
    });

    const restored = await readFile(from);
    expect(restored.length).toBe(bytes.length);
    expect(hashOf(restored)).toBe(hashOf(bytes));
    expect(existsSync(to)).toBe(false);
  }, 60_000);

  it('leaves no runtime-side staged copy behind after capture and revert', async () => {
    const from = join(tempDir, 'staged.bin');
    const to = join(tempDir, 'staged-moved.bin');
    await writeFile(from, patternBytes(3 * MIB));
    const runtime = await getRuntimeClient(chat.userId);
    const staged: string[] = [];
    const originalRelease = runtime.snapshot.release.bind(runtime.snapshot);
    runtime.snapshot.release = async (params, options) => {
      staged.push(params.stagedId);
      return await originalRelease(params, options);
    };
    try {
      await executeMoveFile({ from, to }, turnContext());
      await revertMessageFileCheckpoints(getDb(), chat.id, messageId);
    } finally {
      runtime.snapshot.release = originalRelease;
    }

    // One release for the capture and one for the upload; each names an id the
    // runtime no longer serves.
    expect(staged).toHaveLength(2);
    for (const stagedId of staged) {
      const error = await runtime.snapshot.readChunk({ stagedId, offset: 0, length: 1 }).then(
        () => null,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(RemoteError);
      expect((error as RemoteError).details?.kind).toBe('snapshot_stage_missing');
    }
  });

  it('is refused above the configured limit and left where it was', async () => {
    const config = getConfig();
    const previousLimit = config.checkpoints.maxFileBytes;
    config.checkpoints.maxFileBytes = MIB;
    const from = join(tempDir, 'too-big.bin');
    const to = join(tempDir, 'too-big-moved.bin');
    const size = 3 * MIB;
    await writeFile(from, patternBytes(size));

    try {
      const error = await executeMoveFile({ from, to }, turnContext()).then(
        () => null,
        (reason: unknown) => reason
      );

      expect(error).toBeInstanceOf(RemoteError);
      expect((error as RemoteError).message).toContain(`it is ${size} bytes`);
      expect((error as RemoteError).message).toContain(`${MIB}-byte checkpoint limit`);
      expect((error as RemoteError).details).toMatchObject({
        kind: 'snapshot_too_large',
        sizeBytes: size,
        limitBytes: MIB,
      });
    } finally {
      config.checkpoints.maxFileBytes = previousLimit;
    }
    expect(statSync(from).size).toBe(size);
    expect(existsSync(to)).toBe(false);
    expect(await checkpointRows()).toHaveLength(0);
  });

  it('records a degraded row, without failing the mutation, when the staged capture is gone', async () => {
    const path = join(tempDir, 'vanished.bin');
    await writeFile(path, patternBytes(2 * MIB));

    const { captured } = await withMutationPersistence(turnContext(), [path], () =>
      Promise.resolve({
        result: { path },
        mutations: [
          {
            path,
            op: 'edit' as const,
            before: {
              exists: true,
              hash: hashOf(Buffer.from('whatever')),
              sizeBytes: 2 * MIB,
              stagedId: 'never-staged',
            },
            afterHash: hashOf(Buffer.from('after')),
          },
        ],
      })
    );

    expect(captured[0]?.fields).toEqual({ beforeOmitted: 'corrupt' });
    const rows = await checkpointRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blobKey).toBeNull();
    expect(rows[0]?.beforeHash).toBeNull();
  });

  it('records a degraded row when the staged bytes do not match the reported hash', async () => {
    const path = join(tempDir, 'mismatch.bin');
    await writeFile(path, patternBytes(2 * MIB));
    const runtime = await getRuntimeClient(chat.userId);
    const capture = await runtime.snapshot.capture({ path });
    expect(capture.stagedId).toBeString();

    const { captured } = await withMutationPersistence(turnContext(), [path], () =>
      Promise.resolve({
        result: { path },
        mutations: [
          {
            path,
            op: 'edit' as const,
            before: { ...capture, hash: hashOf(Buffer.from('not the file')) },
            afterHash: hashOf(Buffer.from('after')),
          },
        ],
      })
    );

    expect(captured[0]?.fields).toEqual({ beforeOmitted: 'corrupt' });
    expect((await checkpointRows())[0]?.blobKey).toBeNull();
  });
});

describe('the checkpoint blob store streams', () => {
  it('stores chunks under their content hash and reads them back as bounded slices', async () => {
    const bytes = patternBytes(2 * SNAPSHOT_CHUNK_MAX_BYTES + 17);
    function* chunksOf(source: Buffer): Generator<Uint8Array> {
      for (let offset = 0; offset < source.length; offset += 700_000) {
        yield source.subarray(offset, offset + 700_000);
      }
    }

    const { blobKey, size } = await storeCheckpointBlobStream(chunksOf(bytes), hashOf(bytes));

    expect({ blobKey, size }).toEqual({ blobKey: hashOf(bytes), size: bytes.length });
    const slices: Uint8Array[] = [];
    for await (const slice of readCheckpointBlobChunks(blobKey, SNAPSHOT_CHUNK_MAX_BYTES)) {
      expect(slice.byteLength).toBeLessThanOrEqual(SNAPSHOT_CHUNK_MAX_BYTES);
      slices.push(slice);
    }
    expect(hashOf(Buffer.concat(slices))).toBe(hashOf(bytes));
  });

  it('refuses a stream whose digest differs and leaves nothing stored', async () => {
    const bytes = patternBytes(1000);
    const wrongHash = hashOf(Buffer.from('other'));
    function* oneChunk(): Generator<Uint8Array> {
      yield bytes;
    }

    await expect(storeCheckpointBlobStream(oneChunk(), wrongHash)).rejects.toThrow(
      `hashes to ${hashOf(bytes)}, but its source reported ${wrongHash}`
    );

    expect(checkpointBlobSize(hashOf(bytes))).toBe(0);
    expect(checkpointBlobSize(wrongHash)).toBe(0);
  });

  it('refuses to read a blob that is not stored instead of reading it as empty', async () => {
    const missing = hashOf(Buffer.from('never stored'));

    await expect(async () => {
      for await (const slice of readCheckpointBlobChunks(missing, 1024)) void slice;
    }).toThrow(`Checkpoint blob ${missing} is no longer available.`);
  });
});
