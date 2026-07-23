import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getCheckpointsDir } from '../../../lib/mango-paths';

function hashBuffer(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

function blobPathForKey(blobKey: string): string {
  const prefix = blobKey.slice(0, 2);
  return join(getCheckpointsDir(), prefix, blobKey);
}

/** Persists bytes once per content hash; returns the blob key (sha256). */
export async function storeCheckpointBlob(bytes: Uint8Array): Promise<string> {
  const blobKey = hashBuffer(bytes);
  const path = blobPathForKey(blobKey);
  if (await Bun.file(path).exists()) return blobKey;
  await mkdir(join(getCheckpointsDir(), blobKey.slice(0, 2)), { recursive: true });
  await Bun.write(path, bytes);
  return blobKey;
}

export async function readCheckpointBlob(blobKey: string): Promise<Uint8Array | null> {
  const path = blobPathForKey(blobKey);
  if (!(await Bun.file(path).exists())) return null;
  return Bun.file(path).bytes();
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
