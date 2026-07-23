import { stat } from 'node:fs/promises';
import { type ObservedFileRead, readFileWithObservedMtime } from './builtin/_fs-utils';

const MAX_ENTRIES_PER_CHAT = 256;
const MAX_ENTRIES_GLOBAL = 10_000;

interface FileFreshnessEntry {
  readonly sha256: string;
  readonly size: number;
  /** `NaN` when the metadata could not be captured, forcing the hash path. */
  readonly mtimeMs: number;
}

interface FileFreshnessLocation {
  readonly chatId: string;
  readonly resolvedPath: string;
}

const entriesByChat = new Map<string, Map<string, FileFreshnessEntry>>();
const globalLru = new Map<FileFreshnessEntry, FileFreshnessLocation>();
const pathLockTails = new Map<string, Promise<void>>();

// Subagents deliberately share their parent's chatId, so their reads and the
// parent turn participate in the same freshness boundary in this first version.

export class FileNotReadError extends Error {
  constructor(resolvedPath: string) {
    super(`You must read "${resolvedPath}" with read_file before modifying it.`);
    this.name = 'FileNotReadError';
  }
}

export class StaleFileError extends Error {
  constructor(resolvedPath: string) {
    super(
      `"${resolvedPath}" changed on disk since it was last read (content hash mismatch). ` +
        'Re-read the file and retry with the current content.'
    );
    this.name = 'StaleFileError';
  }
}

/**
 * Records the exact bytes a chat observed and returns their SHA-256 digest.
 *
 * `observedMtimeMs` must come from the descriptor those bytes were read from —
 * or from the descriptor they were written through — so size, mtime, and hash
 * all describe one snapshot. Pass `NaN` when no such observation exists; the
 * entry then always takes the hashing path instead of the metadata fast path.
 */
export function recordFileRead(
  chatId: string,
  resolvedPath: string,
  content: Uint8Array | string,
  observedMtimeMs: number
): string {
  const sha256 = hashContent(content);
  storeEntry(chatId, resolvedPath, {
    sha256,
    size: contentSize(content),
    mtimeMs: observedMtimeMs,
  });
  return sha256;
}

/** Verifies that a file still matches the most recent content observed by this chat. */
export async function assertFresh(chatId: string, resolvedPath: string): Promise<void> {
  const entry = entriesByChat.get(chatId)?.get(resolvedPath);
  if (!entry) throw new FileNotReadError(resolvedPath);

  const metadata = await getCurrentMetadata(resolvedPath);
  if (metadata.size === entry.size && metadata.mtimeMs === entry.mtimeMs) {
    touchEntry(chatId, resolvedPath, entry);
    return;
  }

  let current: ObservedFileRead;
  try {
    current = await readFileWithObservedMtime(resolvedPath);
  } catch {
    throw new StaleFileError(resolvedPath);
  }

  const sha256 = hashContent(current.bytes);
  if (sha256 !== entry.sha256) throw new StaleFileError(resolvedPath);

  // Metadata-only changes do not make the content stale. Refresh from the read
  // that was just hashed, so the size and mtime restored to the fast path
  // describe the same bytes as the digest beside them.
  storeEntry(chatId, resolvedPath, {
    sha256,
    size: current.bytes.byteLength,
    mtimeMs: current.mtimeMs,
  });
}

/** Removes a chat's snapshot for a path after the path is deleted or replaced. */
export function forgetFile(chatId: string, resolvedPath: string): void {
  removeEntry(chatId, resolvedPath);
}

/** Moves a chat's snapshot along with a successfully renamed file. */
export function rekeyFile(chatId: string, from: string, to: string): void {
  if (from === to) {
    const entry = entriesByChat.get(chatId)?.get(from);
    if (entry) touchEntry(chatId, from, entry);
    return;
  }

  const entry = entriesByChat.get(chatId)?.get(from);
  removeEntry(chatId, to);
  if (!entry) return;

  removeEntry(chatId, from);
  storeEntry(chatId, to, entry);
}

/**
 * Runs a filesystem mutation while holding every requested path lock.
 * Sorting and deduplicating the paths keeps multi-path operations deadlock-free.
 */
export async function withPathLocks<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
  const releases: Array<() => void> = [];
  const orderedPaths = [...new Set(paths)].sort();

  try {
    for (const path of orderedPaths) releases.push(await acquirePathLock(path));
    return await fn();
  } finally {
    for (let index = releases.length - 1; index >= 0; index--) releases[index]?.();
  }
}

/** Clears all in-memory snapshots for test isolation. */
export function clearFileFreshness(): void {
  entriesByChat.clear();
  globalLru.clear();
}

function hashContent(content: Uint8Array | string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return hasher.digest('hex');
}

function contentSize(content: Uint8Array | string): number {
  return typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
}

async function getCurrentMetadata(
  resolvedPath: string
): Promise<{ size: number; mtimeMs: number }> {
  try {
    const metadata = await stat(resolvedPath);
    return { size: metadata.size, mtimeMs: metadata.mtimeMs };
  } catch {
    throw new StaleFileError(resolvedPath);
  }
}

function storeEntry(chatId: string, resolvedPath: string, entry: FileFreshnessEntry): void {
  let chatEntries = entriesByChat.get(chatId);
  if (!chatEntries) {
    chatEntries = new Map();
    entriesByChat.set(chatId, chatEntries);
  }

  const previous = chatEntries.get(resolvedPath);
  if (previous) globalLru.delete(previous);
  chatEntries.delete(resolvedPath);
  chatEntries.set(resolvedPath, entry);
  globalLru.set(entry, { chatId, resolvedPath });

  while (chatEntries.size > MAX_ENTRIES_PER_CHAT) {
    const oldestPath = chatEntries.keys().next().value;
    if (oldestPath === undefined) break;
    removeEntry(chatId, oldestPath);
  }

  while (globalLru.size > MAX_ENTRIES_GLOBAL) {
    const oldest = globalLru.values().next().value;
    if (!oldest) break;
    removeEntry(oldest.chatId, oldest.resolvedPath);
  }
}

function touchEntry(chatId: string, resolvedPath: string, entry: FileFreshnessEntry): void {
  const chatEntries = entriesByChat.get(chatId);
  if (!chatEntries?.has(resolvedPath)) return;

  chatEntries.delete(resolvedPath);
  chatEntries.set(resolvedPath, entry);
  globalLru.delete(entry);
  globalLru.set(entry, { chatId, resolvedPath });
}

function removeEntry(chatId: string, resolvedPath: string): void {
  const chatEntries = entriesByChat.get(chatId);
  const entry = chatEntries?.get(resolvedPath);
  if (!chatEntries || !entry) return;

  chatEntries.delete(resolvedPath);
  globalLru.delete(entry);
  if (chatEntries.size === 0) entriesByChat.delete(chatId);
}

async function acquirePathLock(path: string): Promise<() => void> {
  const previous = pathLockTails.get(path) ?? Promise.resolve();
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(() => gate);
  pathLockTails.set(path, tail);

  await previous;
  return () => {
    releaseGate();
    if (pathLockTails.get(path) === tail) pathLockTails.delete(path);
  };
}
