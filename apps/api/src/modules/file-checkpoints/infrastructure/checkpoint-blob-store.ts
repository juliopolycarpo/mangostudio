import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getConfig } from '../../../lib/config';

/** Directory under the checkpoint root where a blob lives until its hash is known. */
const INCOMING_DIR = '.incoming';

/** The streamed bytes did not hash to the digest the caller expected. */
export class CheckpointBlobHashMismatchError extends Error {
  constructor(
    readonly expectedHash: string,
    readonly observedHash: string
  ) {
    super(
      `Checkpoint blob hashes to ${observedHash}, but its source reported ${expectedHash}; it was not stored.`
    );
    this.name = 'CheckpointBlobHashMismatchError';
  }
}

/** SHA-256 of the bytes; doubles as the content-addressed blob key. */
export function hashCheckpointBytes(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

function blobPathForKey(blobKey: string): string {
  return join(getConfig().checkpoints.dir, blobKey.slice(0, 2), blobKey);
}

/** Persists bytes once per content hash; returns the blob key (sha256). */
export async function storeCheckpointBlob(bytes: Uint8Array): Promise<string> {
  const blobKey = hashCheckpointBytes(bytes);
  const path = blobPathForKey(blobKey);
  if (await Bun.file(path).exists()) return blobKey;
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, bytes);
  return blobKey;
}

/**
 * Persists a blob from a stream of chunks without holding it in memory: bytes
 * go to a temporary file while the digest accumulates, and the file is renamed
 * to its content-addressed name only once the digest is known (and equals
 * `expectedHash`, when given). A failed or mismatched stream leaves no file.
 *
 * // Usage: const { blobKey, size } = await storeCheckpointBlobStream(chunks, snapshot.hash)
 */
export async function storeCheckpointBlobStream(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  expectedHash?: string
): Promise<{ readonly blobKey: string; readonly size: number }> {
  const incomingDir = join(getConfig().checkpoints.dir, INCOMING_DIR);
  await mkdir(incomingDir, { recursive: true });
  const incomingPath = join(incomingDir, `${randomUUID()}.part`);
  const hasher = new Bun.CryptoHasher('sha256');
  const handle = await open(incomingPath, 'wx');
  let handleOpen = true;
  try {
    let size = 0;
    for await (const chunk of chunks) {
      hasher.update(chunk);
      await handle.writeFile(chunk);
      size += chunk.byteLength;
    }
    await handle.close();
    handleOpen = false;

    const blobKey = hasher.digest('hex');
    if (expectedHash !== undefined && blobKey !== expectedHash) {
      throw new CheckpointBlobHashMismatchError(expectedHash, blobKey);
    }
    const path = blobPathForKey(blobKey);
    if (await Bun.file(path).exists()) {
      await rm(incomingPath, { force: true });
    } else {
      await mkdir(dirname(path), { recursive: true });
      await rename(incomingPath, path);
    }
    return { blobKey, size };
  } catch (error) {
    if (handleOpen) await handle.close().catch(() => undefined);
    await rm(incomingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readCheckpointBlob(blobKey: string): Promise<Uint8Array | null> {
  const path = blobPathForKey(blobKey);
  if (!(await Bun.file(path).exists())) return null;
  return Bun.file(path).bytes();
}

/**
 * Reads a blob as consecutive slices of at most `chunkBytes`, so a large blob
 * crosses the wire without ever being loaded whole. Yields nothing for an empty
 * blob; throws when the blob is gone, so a missing file is never mistaken for an
 * empty one.
 *
 * // Usage: for await (const chunk of readCheckpointBlobChunks(blobKey, 1024 * 1024)) { ... }
 */
export async function* readCheckpointBlobChunks(
  blobKey: string,
  chunkBytes: number
): AsyncGenerator<Uint8Array> {
  const file = Bun.file(blobPathForKey(blobKey));
  if (!(await file.exists())) {
    throw new Error(`Checkpoint blob ${blobKey} is no longer available.`);
  }
  const size = file.size;
  for (let offset = 0; offset < size; offset += chunkBytes) {
    yield await file.slice(offset, Math.min(offset + chunkBytes, size)).bytes();
  }
}

/**
 * Stored size of a blob taken from its directory entry, so retention accounting
 * never loads blob contents into memory. `0` when the blob is already gone.
 */
export function checkpointBlobSize(blobKey: string): number {
  return Bun.file(blobPathForKey(blobKey)).size;
}

/** Whether the blob's file is still on disk. */
export function checkpointBlobExists(blobKey: string): Promise<boolean> {
  return Bun.file(blobPathForKey(blobKey)).exists();
}

export async function deleteCheckpointBlobIfUnreferenced(
  blobKey: string,
  isStillReferenced: (key: string) => Promise<boolean>
): Promise<void> {
  if (await isStillReferenced(blobKey)) return;
  const path = blobPathForKey(blobKey);
  await Bun.file(path)
    .delete()
    .catch(() => undefined);
}
