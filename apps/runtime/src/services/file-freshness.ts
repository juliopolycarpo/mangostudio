import { stat } from 'node:fs/promises';
import { RuntimeServiceError } from '../errors';
import { type ObservedFileRead, readFileWithObservedMtime } from './fs-utils';

/**
 * Read-before-destroy invariant and its actual boundary.
 *
 * `assertFresh`/`readFreshFile` require a chat to have read a file's current
 * bytes before `delete_file` or a `write_file` overwrite may act on it — see
 * `services/fs/delete-file.ts` and `services/fs/write-file.ts`.
 * `services/fs/move-file.ts` does not call into this module at all: a rename
 * does not require the source to have been read.
 *
 * That is not an oversight. What stands in for the read-first gate on a move
 * is containment, not freshness: `guardPaths` (`fs-path-policy.ts`) refuses,
 * unconditionally, any move whose destination resolves outside a chat's
 * `pathPolicy.containmentRoot` — before `moveRuntimeFile` runs at all. That is
 * a stronger guarantee than gating on `assertFresh` would be, since the move
 * is never admitted, read or not.
 *
 * The boundary this does not cover: a chat with no containment root (the
 * default — empty `allowedPaths`/`deniedPaths`) can move a file anywhere
 * without reading it first, which is functionally an unguarded delete. That
 * gap is accepted, not closed. See #632.
 */

const MAX_ENTRIES_PER_CHAT = 256;
const MAX_ENTRIES_GLOBAL = 10_000;

interface FileFreshnessEntry {
  readonly sha256: string;
  readonly size: number;
  /** `NaN` when the metadata could not be captured, forcing the hash path. */
  readonly mtimeMs: number;
  /**
   * Highest line N such that lines 1..N of these exact bytes have been observed.
   * `Number.MAX_SAFE_INTEGER` when the whole content was observed at once.
   */
  readonly coveredThroughLine: number;
  /** Whether the observation covers the entire file. Only writes gate on this. */
  readonly complete: boolean;
  /**
   * Highest line number that still means what the model was last shown. A write
   * that changes the line count renumbers everything after the first line it
   * touched, so only the untouched prefix keeps its numbers. Line-addressed
   * tools gate on this; content-addressed ones do not care.
   */
  readonly lineNumbersValidThroughLine: number;
}

/** The slice of a file a single windowed read put in front of the model. */
export interface ObservedLineRange {
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
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

export class FileNotReadError extends RuntimeServiceError {
  constructor(resolvedPath: string) {
    super('file_not_read', `You must read "${resolvedPath}" with read_file before modifying it.`, {
      resolvedPath,
    });
    this.name = 'FileNotReadError';
  }
}

export class PartialReadError extends RuntimeServiceError {
  constructor(resolvedPath: string, coveredThroughLine: number) {
    const observed =
      coveredThroughLine > 0
        ? `only lines 1-${coveredThroughLine} have been read`
        : 'it has not been read from line 1';
    super(
      'partial_read',
      `Cannot modify "${resolvedPath}": ${observed} in this chat. A safe mutation requires a ` +
        'complete view of the current file, so read the remaining lines with read_file ' +
        '(startLine/maxLines) first.',
      { resolvedPath, coveredThroughLine }
    );
    this.name = 'PartialReadError';
  }
}

export class StaleFileError extends RuntimeServiceError {
  constructor(resolvedPath: string) {
    super(
      'stale_file',
      `"${resolvedPath}" changed on disk since it was last read (content hash mismatch). ` +
        'Re-read the file and retry with the current content.',
      { resolvedPath }
    );
    this.name = 'StaleFileError';
  }
}

export class StaleLineNumbersError extends RuntimeServiceError {
  constructor(resolvedPath: string, validThroughLine: number) {
    const remaining =
      validThroughLine > 0
        ? `only lines 1-${validThroughLine} still match the last read`
        : 'no line numbers still match the last read';
    super(
      'stale_line_numbers',
      `Line numbers for "${resolvedPath}" are stale: an earlier edit in this chat changed the ` +
        `file's line count, so ${remaining}. Re-read the file with read_file to get the ` +
        'current numbering before replacing this range.',
      { resolvedPath, validThroughLine }
    );
    this.name = 'StaleLineNumbersError';
  }
}

/**
 * Records the exact bytes a chat observed and returns their SHA-256 digest.
 *
 * `observedMtimeMs` must come from the descriptor those bytes were read from —
 * or from the descriptor they were written through — so size, mtime, and hash
 * all describe one snapshot. Pass `NaN` when no such observation exists; the
 * entry then always takes the hashing path instead of the metadata fast path.
 *
 * `content` is always the whole file, because the digest has to answer "did
 * this file change on disk". `observedRange` narrows what the model was
 * actually shown; omit it when the caller put the entire content in front of
 * the model. Sequential windows accumulate, so paging through a file from
 * line 1 eventually covers it.
 *
 * Whole-content callers are authoritative about line numbering — read_file
 * shows it, create_file and write_file author it — so this resets any shift
 * recorded by {@link recordFileEdit}.
 */
export function recordFileRead(
  chatId: string,
  resolvedPath: string,
  content: Uint8Array | string,
  observedMtimeMs: number,
  observedRange?: ObservedLineRange
): string {
  const sha256 = hashContent(content);
  const coveredThroughLine = observedRange
    ? extendCoverage(chatId, resolvedPath, sha256, observedRange)
    : Number.MAX_SAFE_INTEGER;
  storeEntry(chatId, resolvedPath, {
    sha256,
    size: contentSize(content),
    mtimeMs: observedMtimeMs,
    coveredThroughLine,
    complete: coveredThroughLine >= (observedRange?.totalLines ?? 0),
    lineNumbersValidThroughLine: Number.MAX_SAFE_INTEGER,
  });
  return sha256;
}

/**
 * Records the bytes a partial mutation just wrote, plus how far the model's
 * line numbering survived it.
 *
 * The written bytes are current, so content-addressed edits may continue, but a
 * splice that changed the line count moved every line after it — a follow-up
 * line-addressed edit that still uses the numbering from the last read would
 * silently hit the wrong lines. Shifts accumulate rather than reset: only a
 * fresh whole-content observation can widen the frontier again.
 *
 * // Usage: recordFileEdit(chatId, path, updated, mtimeMs, startLine - 1)
 */
export function recordFileEdit(
  chatId: string,
  resolvedPath: string,
  content: Uint8Array | string,
  observedMtimeMs: number,
  lineNumbersValidThroughLine: number
): string {
  const previous = entriesByChat.get(chatId)?.get(resolvedPath);
  const sha256 = hashContent(content);
  storeEntry(chatId, resolvedPath, {
    sha256,
    size: contentSize(content),
    mtimeMs: observedMtimeMs,
    coveredThroughLine: Number.MAX_SAFE_INTEGER,
    complete: true,
    lineNumbersValidThroughLine: Math.min(
      previous?.lineNumbersValidThroughLine ?? Number.MAX_SAFE_INTEGER,
      lineNumbersValidThroughLine
    ),
  });
  return sha256;
}

/**
 * Merges a freshly observed window into the coverage already recorded for the
 * same bytes. A window that starts past the covered frontier leaves a hole, so
 * it cannot extend it; different bytes reset coverage entirely.
 */
function extendCoverage(
  chatId: string,
  resolvedPath: string,
  sha256: string,
  observedRange: ObservedLineRange
): number {
  const previous = entriesByChat.get(chatId)?.get(resolvedPath);
  const carried = previous?.sha256 === sha256 ? previous.coveredThroughLine : 0;
  if (observedRange.startLine > carried + 1) return carried;
  return Math.max(carried, observedRange.endLine);
}

function getCompleteEntry(chatId: string, resolvedPath: string): FileFreshnessEntry {
  const entry = entriesByChat.get(chatId)?.get(resolvedPath);
  if (!entry) throw new FileNotReadError(resolvedPath);
  // A windowed read hashes the whole file but only shows part of it, so a
  // matching digest alone would let the model overwrite lines it never saw.
  if (!entry.complete) throw new PartialReadError(resolvedPath, entry.coveredThroughLine);
  return entry;
}

/**
 * Verifies supplied bytes against the most recent complete content observed by
 * this chat. Mutation tools that need the current content should use
 * {@link readFreshFile} so the bytes they edit are the bytes this check hashed.
 */
export function assertFreshContent(
  chatId: string,
  resolvedPath: string,
  content: Uint8Array | string
): void {
  const entry = getCompleteEntry(chatId, resolvedPath);
  if (contentSize(content) !== entry.size || hashContent(content) !== entry.sha256) {
    throw new StaleFileError(resolvedPath);
  }
  touchEntry(chatId, resolvedPath, entry);
}

/**
 * Reads and verifies one filesystem snapshot for a read-modify-write operation.
 * The size ceiling comes from the recorded snapshot: a larger file cannot have
 * the same digest, and is stale without needing to be loaded into memory.
 */
export async function readFreshFile(
  chatId: string,
  resolvedPath: string
): Promise<ObservedFileRead> {
  const entry = getCompleteEntry(chatId, resolvedPath);
  let current: ObservedFileRead;
  try {
    current = await readFileWithObservedMtime(resolvedPath, { maxBytes: entry.size });
  } catch {
    throw new StaleFileError(resolvedPath);
  }
  assertFreshContent(chatId, resolvedPath, current.bytes);
  return current;
}

/** Verifies that a file still matches the most recent content observed by this chat. */
export async function assertFresh(chatId: string, resolvedPath: string): Promise<void> {
  const entry = getCompleteEntry(chatId, resolvedPath);

  const metadata = await getCurrentMetadata(resolvedPath);
  if (metadata.size === entry.size && metadata.mtimeMs === entry.mtimeMs) {
    touchEntry(chatId, resolvedPath, entry);
    return;
  }

  let current: ObservedFileRead;
  try {
    // A different byte count cannot hash to the recorded digest, so anything
    // larger than the snapshot is stale by definition. Capping the re-read at
    // that size keeps a file that ballooned since the read out of memory.
    current = await readFileWithObservedMtime(resolvedPath, { maxBytes: entry.size });
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
    coveredThroughLine: entry.coveredThroughLine,
    complete: entry.complete,
    lineNumbersValidThroughLine: entry.lineNumbersValidThroughLine,
  });
}

/**
 * Verifies that a 1-indexed inclusive range still addresses the lines the model
 * meant. Call after {@link assertFresh}: matching content only proves the file
 * is unchanged since the last write, not that the numbering the model is quoting
 * survived that write.
 *
 * // Usage: assertLineNumbersCurrent(chatId, resolvedPath, endLine);
 */
export function assertLineNumbersCurrent(
  chatId: string,
  resolvedPath: string,
  endLine: number
): void {
  const validThroughLine =
    entriesByChat.get(chatId)?.get(resolvedPath)?.lineNumbersValidThroughLine ??
    Number.MAX_SAFE_INTEGER;
  if (endLine > validThroughLine) {
    throw new StaleLineNumbersError(resolvedPath, validThroughLine);
  }
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
