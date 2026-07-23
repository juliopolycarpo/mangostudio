import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getConfig } from '../../../lib/config';

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

export async function readCheckpointBlob(blobKey: string): Promise<Uint8Array | null> {
  const path = blobPathForKey(blobKey);
  if (!(await Bun.file(path).exists())) return null;
  return Bun.file(path).bytes();
}

/**
 * Stored size of a blob taken from its directory entry, so retention accounting
 * never loads blob contents into memory. `0` when the blob is already gone.
 */
export function checkpointBlobSize(blobKey: string): number {
  return Bun.file(blobPathForKey(blobKey)).size;
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
