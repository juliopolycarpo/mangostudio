/**
 * The claim one writer takes over a runtime slot for a whole publication.
 *
 * Across runtime processes, not within one: a hub streaming an update into a
 * slot and somebody at the machine running `install` are two processes writing
 * the same version directory and the same `current`, and only a file on disk
 * can hold them apart.
 *
 * A host-local live pid is the authoritative answer to "is the holder still
 * there". Homes mounted across machines cannot use it — the pid means nothing
 * over there — so those fall back to age with a floor well beyond any normal
 * hold. The token is what stops an expired holder from unlinking the lock a
 * replacement holder has since created.
 */

import { type FileHandle, open, readFile, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { RuntimeUpdateError } from '../errors';

/** Kept under the original name: an older build's lock must still be recognised. */
export const RUNTIME_UPDATE_LOCK_FILE = 'runtime-update.lock';
const RUNTIME_UPDATE_LOCK_STALE_FLOOR_MS = 5 * 60_000;

export interface SlotUpdateLock {
  readonly path: string;
  readonly token: string;
}

/**
 * Claims a slot, or refuses because somebody else holds it.
 * // Usage: const lock = await acquireSlotUpdateLock(slotDir, sessionId, 120_000)
 */
export async function acquireSlotUpdateLock(
  slotDir: string,
  token: string,
  holdTimeoutMs: number
): Promise<SlotUpdateLock> {
  const path = join(slotDir, RUNTIME_UPDATE_LOCK_FILE);
  const reclaimPath = `${path}.reclaim`;
  const staleMs = Math.max(RUNTIME_UPDATE_LOCK_STALE_FLOOR_MS, holdTimeoutMs * 2);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (
      await stat(reclaimPath).then(
        () => true,
        () => false
      )
    ) {
      throw slotBusy();
    }
    let handle: FileHandle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && (await reclaimAbandonedLock(path, staleMs))) continue;
      throw slotBusy();
    }

    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname() }));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return { path, token };
  }

  throw slotBusy();
}

export async function releaseSlotUpdateLock(lock: SlotUpdateLock): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(lock.path, 'utf8')) as { readonly token?: string };
    if (owner.token === lock.token) await unlink(lock.path);
  } catch {
    // Gone, replaced, or unreadable: never remove a lock we cannot identify.
  }
}

function slotBusy(): RuntimeUpdateError {
  return new RuntimeUpdateError('Another slot update is already active.', {
    reason: 'slot_update_active',
  });
}

async function reclaimAbandonedLock(path: string, staleMs: number): Promise<boolean> {
  const reclaimPath = `${path}.reclaim`;
  let reclaimHandle: FileHandle;
  try {
    reclaimHandle = await open(reclaimPath, 'wx', 0o600);
  } catch {
    return false;
  }

  try {
    const [raw, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const owner = raw ? (JSON.parse(raw) as { readonly pid?: number; readonly host?: string }) : {};
    const ownedHere = owner.host === hostname() && typeof owner.pid === 'number';
    const abandoned = ownedHere
      ? !isProcessAlive(owner.pid as number)
      : Date.now() - stats.mtimeMs > staleMs;
    if (!abandoned) return false;
    await unlink(path).catch(() => undefined);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  } finally {
    await reclaimHandle.close().catch(() => undefined);
    await unlink(reclaimPath).catch(() => undefined);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
