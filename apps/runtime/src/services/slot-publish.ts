/**
 * Publishing bytes into a runtime slot, the way each platform spells it.
 *
 * A slot keeps the versions it has been given side by side and points
 * `current` at one of them, so an upgrade replaces a pointer rather than the
 * file a running process is executing. POSIX spells that pointer as a relative
 * symlink swapped by rename; Windows spells it as a directory junction, which
 * needs no privilege and — unlike a file symlink there — no Developer Mode.
 *
 * Windows also cannot swap a directory in one call: `rename` refuses an
 * existing directory as its destination, so the old junction is unlinked first
 * and the staged one renamed over the gap. That gap is why
 * {@link restoreSlotCurrent} exists rather than being an afterthought.
 *
 * Writes run through {@link withSlotWriteRetry} on Windows, where a virus
 * scanner routinely holds a freshly written executable open for a second or
 * two and every write against it fails with `EPERM` until it lets go.
 */

import { rename, rm, rmdir, symlink, readlink as systemReadlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNTIME_CURRENT_LINK_NAME } from '@mangostudio/shared/runtime-home';
import { RUNTIME_UPDATE_LOCK_FILE } from './slot-update-lock';

/** Attempts, and the backoff between them, for a write a scanner may be blocking. */
const SLOT_WRITE_RETRY_ATTEMPTS = 5;
const SLOT_WRITE_RETRY_BASE_MS = 100;

/**
 * Errors a Windows file lock produces. `EBUSY` and `EPERM` are what a scanner
 * or a running executable yield; `UNKNOWN` is what libuv reports for the
 * sharing violations it has no errno for.
 */
const LOCKED_ERROR_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY', 'UNKNOWN']);

/** The filesystem surface publication needs, so a test can drive win32 on Linux. */
export interface SlotPublishFs {
  symlink(target: string, path: string, type?: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a POSIX symlink pointer. */
  unlink(path: string): Promise<void>;
  /** Removes a Windows junction pointer. Never recursive: a real directory must fail here. */
  rmdir(path: string): Promise<void>;
  readlink(path: string): Promise<string>;
}

export interface SlotPublishOptions {
  readonly platform: NodeJS.Platform;
  /** Injected for tests; production passes nothing and gets `node:fs/promises`. */
  readonly fs?: SlotPublishFs;
  readonly sleep?: (ms: number) => Promise<void>;
}

const systemFs: SlotPublishFs = {
  symlink: (target, path, type) => symlink(target, path, type),
  rename,
  unlink,
  rmdir,
  readlink: systemReadlink,
};

/** Whether this error is a Windows sharing violation worth waiting out. */
export function isLockedFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && LOCKED_ERROR_CODES.has(code);
}

/**
 * Runs a slot write, waiting out a Windows file lock.
 *
 * Off Windows this is a plain call: POSIX has no sharing violation to wait
 * out, and an `EACCES` there is a permission problem that will not improve.
 * // Usage: await withSlotWriteRetry(() => rename(a, b), { platform: 'win32' })
 */
export async function withSlotWriteRetry<T>(
  operation: () => Promise<T>,
  options: SlotPublishOptions
): Promise<T> {
  if (options.platform !== 'win32') return await operation();
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= SLOT_WRITE_RETRY_ATTEMPTS || !isLockedFileError(error)) throw error;
      await sleep(SLOT_WRITE_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
}

/** Where `current` lives for a slot directory. */
export function slotCurrentPath(slotDir: string): string {
  return join(slotDir, RUNTIME_CURRENT_LINK_NAME);
}

/**
 * Moves one file inside a slot, waiting out a Windows lock.
 *
 * Separate from the pointer helpers because the bytes and the pointer fail for
 * different reasons, and only the caller knows which one it was moving.
 * // Usage: await moveSlotFile(incoming, live, { platform: 'win32' })
 */
export function moveSlotFile(from: string, to: string, options: SlotPublishOptions): Promise<void> {
  const fs = options.fs ?? systemFs;
  return withSlotWriteRetry(() => fs.rename(from, to), options);
}

/**
 * What `current` points at, or null when there is no pointer.
 *
 * The raw target, not a version: POSIX stores the version name and Windows
 * stores the absolute directory. {@link slotVersionFromPointer} reads the
 * version out of either.
 */
export async function readSlotCurrentTarget(
  slotDir: string,
  options: SlotPublishOptions
): Promise<string | null> {
  const fs = options.fs ?? systemFs;
  return await fs.readlink(slotCurrentPath(slotDir)).catch(() => null);
}

/**
 * The version directory name a pointer target names.
 *
 * Both separators, because a Windows junction target is an absolute path and a
 * POSIX symlink target is the bare name this module wrote. Reading the version
 * back out is what keeps the previous directory off the prune list on both.
 * // Usage: slotVersionFromPointer('C:\\Users\\a\\.mango\\runtime\\remote\\1.2.0') // → "1.2.0"
 */
export function slotVersionFromPointer(target: string | null): string | null {
  if (!target) return null;
  const trimmed = target.replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  return name.length > 0 ? name : null;
}

/**
 * Points `current` at a version directory, replacing whatever was there.
 *
 * `stageId` names the temporary pointer and must be unique per caller: two
 * publications racing inside one slot would otherwise rename each other's
 * staged link away. Returns the target it wrote, which is what
 * {@link restoreSlotCurrent} takes to undo it.
 * // Usage: await publishSlotCurrent(slotDir, '1.2.0', sessionId, { platform: 'linux' })
 */
export async function publishSlotCurrent(
  slotDir: string,
  version: string,
  stageId: string,
  options: SlotPublishOptions
): Promise<string> {
  const target = options.platform === 'win32' ? join(slotDir, version) : version;
  await writePointer(slotDir, target, `.${RUNTIME_CURRENT_LINK_NAME}.${stageId}`, options);
  return target;
}

/**
 * Puts back the pointer a failed publication replaced, or removes it when
 * there was none. The caller is already unwinding, so this reports failure by
 * rejecting and does nothing else with it.
 */
export async function restoreSlotCurrent(
  slotDir: string,
  previousTarget: string | null,
  stageId: string,
  options: SlotPublishOptions
): Promise<void> {
  if (!previousTarget) {
    await removePointer(slotCurrentPath(slotDir), options);
    return;
  }
  await writePointer(
    slotDir,
    previousTarget,
    `.${RUNTIME_CURRENT_LINK_NAME}.rollback.${stageId}`,
    options
  );
}

/**
 * Removes every version directory but the two that are still in use.
 *
 * The previous one stays because a process launched through the old pointer is
 * executing out of it — on Windows the filesystem enforces that, and on POSIX
 * the open inode survives a delete but the directory a `doctor` reports would
 * not. Everything else is a version an earlier publication superseded.
 * // Usage: await pruneSlotVersions(slotDir, '1.2.0', '1.1.0')
 */
export async function pruneSlotVersions(
  slotDir: string,
  currentVersion: string,
  previousVersion: string | null
): Promise<void> {
  const entries = await Array.fromAsync(new Bun.Glob('*').scan({ cwd: slotDir, onlyFiles: false }));
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry !== currentVersion &&
          entry !== previousVersion &&
          entry !== RUNTIME_CURRENT_LINK_NAME &&
          !entry.endsWith('.json') &&
          !entry.endsWith('.lock') &&
          // `runtime-update.lock.reclaim` ends in neither, and unlinking another
          // process's reclaim guard mid-flight lets two of them reclaim the same
          // lock. Prefix rather than suffix so every file the lock owns is kept.
          !entry.startsWith(RUNTIME_UPDATE_LOCK_FILE)
      )
      // Per entry, not per batch: Windows refuses to delete a directory holding
      // a running executable, and one refusal used to abandon every other
      // removal in the same `Promise.all`. Pruning is housekeeping — the next
      // publication sweeps whatever this leaves behind.
      .map((entry) =>
        rm(join(slotDir, entry), { recursive: true, force: true }).catch(() => undefined)
      )
  );
}

/**
 * Stages a pointer beside the live one and moves it over.
 *
 * On POSIX the move is the swap: `rename` replaces a symlink in one step, so
 * no reader ever sees the slot without a pointer. Windows refuses `rename`
 * onto an existing directory, junction included, so the old pointer is
 * unlinked first — and with `rmdir`, never a recursive remove, so that
 * something which replaced `current` with a real populated directory fails
 * loudly instead of being deleted.
 */
async function writePointer(
  slotDir: string,
  target: string,
  stageName: string,
  options: SlotPublishOptions
): Promise<void> {
  const fs = options.fs ?? systemFs;
  const windows = options.platform === 'win32';
  const currentPath = slotCurrentPath(slotDir);
  const stagePath = join(slotDir, stageName);

  await removePointer(stagePath, options).catch(() => undefined);
  await withSlotWriteRetry(
    () => fs.symlink(target, stagePath, windows ? 'junction' : undefined),
    options
  );
  try {
    if (windows) await removePointer(currentPath, options);
    await withSlotWriteRetry(() => fs.rename(stagePath, currentPath), options);
  } catch (error) {
    await removePointer(stagePath, options).catch(() => undefined);
    throw error;
  }
}

/** Unlinks a pointer, treating "already gone" as done. */
async function removePointer(path: string, options: SlotPublishOptions): Promise<void> {
  const fs = options.fs ?? systemFs;
  const remove = options.platform === 'win32' ? fs.rmdir : fs.unlink;
  try {
    await withSlotWriteRetry(() => remove(path), options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
