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
 * over there — so a foreign claim needs manual verification before removal.
 * The token stops an old holder from unlinking a replacement claim.
 */

import { randomUUID } from 'node:crypto';
import { type FileHandle, open, readFile, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { RuntimeUpdateError } from '../errors';

/** Kept under the original name: an older build's lock must still be recognised. */
const RUNTIME_UPDATE_LOCK_FILE = 'runtime-update.lock';
const LOCK_HEARTBEAT_MS = 30_000;

interface HeldLock {
  readonly handle: FileHandle;
  readonly timer: ReturnType<typeof setInterval>;
  pending?: Promise<void>;
  released: boolean;
}

const heldLocks = new WeakMap<SlotUpdateLock, HeldLock>();

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
  _holdTimeoutMs: number
): Promise<SlotUpdateLock> {
  const path = join(slotDir, RUNTIME_UPDATE_LOCK_FILE);
  const reclaimPath = `${path}.reclaim`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await exists(reclaimPath)) throw slotBusy(reclaimPath);
    let handle: FileHandle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 0 && (await reclaimAbandonedLock(path))) continue;
      throw slotBusy(path);
    }

    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname() }));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
    const lock = { path, token };
    const held: HeldLock = {
      handle,
      timer: setInterval(async () => {
        if (held.released || held.pending) return;
        const pending = refreshHeldLock(lock, held).finally(() => {
          if (held.pending === pending) held.pending = undefined;
        });
        held.pending = pending;
        await pending.catch(() => undefined);
      }, LOCK_HEARTBEAT_MS),
      released: false,
    };
    held.timer.unref();
    heldLocks.set(lock, held);
    return lock;
  }

  throw slotBusy();
}

/** Releases only the matching claim; a successor's lock is kept. Usage: await releaseSlotUpdateLock(lock). */
export async function releaseSlotUpdateLock(lock: SlotUpdateLock): Promise<void> {
  const held = heldLocks.get(lock);
  if (held?.released) return;
  if (held) {
    held.released = true;
    clearInterval(held.timer);
    await held.pending?.catch(() => undefined);
  }
  try {
    const owner = JSON.parse(await readFile(lock.path, 'utf8')) as { readonly token?: string };
    const current = await stat(lock.path);
    const opened = await held?.handle.stat();
    if (owner.token === lock.token && (!opened || sameFile(opened, current))) {
      await unlink(lock.path);
    }
  } catch {
    // Gone, replaced, or unreadable: never remove a lock we cannot identify.
  } finally {
    await held?.handle.close().catch(() => undefined);
  }
}

async function refreshHeldLock(lock: SlotUpdateLock, held: HeldLock): Promise<void> {
  const [opened, current] = await Promise.all([
    held.handle.stat(),
    stat(lock.path).catch(() => null),
  ]);
  if (held.released || !current || !sameFile(opened, current)) return;
  const now = new Date();
  await held.handle.utimes(now, now);
}

function sameFile(
  first: { dev: number; ino: number },
  second: { dev: number; ino: number }
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

function slotBusy(blockingPath?: string): RuntimeUpdateError {
  const message = blockingPath
    ? `Another slot update is already active. Verify no update owns ${blockingPath} before removing it manually.`
    : 'Another slot update is already active.';
  return new RuntimeUpdateError(message, {
    reason: 'slot_update_active',
  });
}

async function reclaimAbandonedLock(path: string): Promise<boolean> {
  const reclaimPath = `${path}.reclaim`;
  let reclaimHandle: FileHandle;
  try {
    reclaimHandle = await open(reclaimPath, 'wx', 0o600);
  } catch {
    return false;
  }

  try {
    await reclaimHandle.writeFile(
      JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname() })
    );
    const lockHandle = await open(path, 'r');
    let raw: string;
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      [raw, stats] = await Promise.all([lockHandle.readFile('utf8'), lockHandle.stat()]);
    } finally {
      await lockHandle.close();
    }
    const owner: unknown = JSON.parse(raw);
    if (!isLockOwner(owner)) return false;
    if (owner.host.toLowerCase() !== hostname().toLowerCase() || isProcessAlive(owner.pid)) {
      return false;
    }
    const current = await stat(path).catch(() => null);
    if (!current || !sameFile(stats, current)) return false;
    await unlink(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  } finally {
    const opened = await reclaimHandle.stat().catch(() => null);
    await reclaimHandle.close().catch(() => undefined);
    const current = await stat(reclaimPath).catch(() => null);
    if (opened && current && sameFile(opened, current)) {
      await unlink(reclaimPath).catch(() => undefined);
    }
  }
}

function isLockOwner(value: unknown): value is { token: string; pid: number; host: string } {
  if (typeof value !== 'object' || value === null) return false;
  const owner = value as { token?: unknown; pid?: unknown; host?: unknown };
  return (
    typeof owner.token === 'string' &&
    owner.token.length > 0 &&
    typeof owner.pid === 'number' &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    owner.pid <= 0xffff_ffff &&
    typeof owner.host === 'string' &&
    owner.host.length > 0
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
