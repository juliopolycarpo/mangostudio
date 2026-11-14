// A persistent `path -> SHA-256` cache that lets a stamp key skip re-reading a
// file that has not changed. The key hashes thousands of source files, and a
// read-and-hash pass over all of them is a synchronous stall on the runner's
// thread, so the second and later passes answer from here instead.
//
// The cache is an optimisation and never an input. It stores no verdict, only
// what `hashInputContent` would return, so a key computed through it is
// byte-identical to one computed without it. Anything wrong with the file
// (missing, unreadable, malformed, another schema) is an empty cache, and a
// failed write is dropped: neither changes a key or fails the caller.
//
// An entry is trusted only while the file's size, mtime, ctime and inode all
// match what was recorded. The ctime is the guard against a tool that rewrites
// content and restores the mtime: ctime cannot be set from user space.
//
// Git's "racy" rule keeps the stat from lying about a write in the same clock
// tick as the recording: an entry is stored only when the file's mtime and
// ctime are at least `RACY_WINDOW_NS` older than the moment the pass began.
// A file changed more recently than that is read again on every pass until it
// settles. The reference time is taken before the pass's first stat, so it is
// never later than any stat in the pass.
//
// Other rules that keep an entry honest:
//   - The stat is taken before the read. The other order could pair new stat
//     fields with old bytes, which would then match forever.
//   - Only a regular file is cached. `lstat` describes a symlink itself, and a
//     link's own stat does not move when its target's bytes do, so links and
//     everything else take the plain read.
//   - Entries that a pass did not use are dropped when it commits, so the file
//     follows the tree instead of growing.

import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { hashInputContent } from './pass-stamp';

/** Bump when the entry layout changes, so an older cache file reads as empty. */
const CACHE_SCHEMA = 1;

/** How much older than the start of a pass a file's mtime and ctime must be for its entry to be kept. */
const RACY_WINDOW_NS = 2_000_000_000n;

/** The stat fields are decimal strings: JSON has no 64-bit integers. */
interface CacheEntry {
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly ino: string;
  readonly sha256: string;
}

export interface FileHashCacheOptions {
  /** Wall clock in milliseconds; replaceable so a test can age a file without sleeping. */
  readonly now?: () => number;
  /** The reader behind a miss; replaceable so a test can count and order the reads. */
  readonly hashFile?: (path: string) => string | null;
}

/** One walk over a file list: hashes through the cache, then records what it learned. */
interface FileHashPass {
  /** The SHA-256 of the file's bytes, or null when the path carries none. Same contract as `hashInputContent`. */
  hashOf(path: string): string | null;
  /** Keep what this pass used and write it when that differs from what was loaded. Never throws. */
  commit(): void;
}

export interface FileHashCache {
  startPass(): FileHashPass;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const { size, mtimeNs, ctimeNs, ino, sha256 } = value as Record<string, unknown>;
  return (
    typeof size === 'string' &&
    typeof mtimeNs === 'string' &&
    typeof ctimeNs === 'string' &&
    typeof ino === 'string' &&
    typeof sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(sha256)
  );
}

/** What the cache file holds; empty when it is missing, unreadable, malformed or from another schema. */
function loadEntries(cachePath: string): Map<string, CacheEntry> {
  const entries = new Map<string, CacheEntry>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return entries;
    const { schema, files } = parsed as Record<string, unknown>;
    if (schema !== CACHE_SCHEMA || typeof files !== 'object' || files === null) return entries;
    for (const [path, entry] of Object.entries(files)) {
      if (isCacheEntry(entry)) entries.set(path, entry);
    }
  } catch {
    // Nothing usable on disk: hash everything.
  }
  return entries;
}

/** Replace the cache file with a complete one. A failure leaves the old file and is ignored. */
function writeEntries(cachePath: string, entries: ReadonlyMap<string, CacheEntry>): void {
  const temporary = `${cachePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      temporary,
      JSON.stringify({ schema: CACHE_SCHEMA, files: Object.fromEntries(entries) })
    );
    renameSync(temporary, cachePath);
  } catch {
    // The cache only saves time; the next pass hashes again.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best effort.
    }
  }
}

/**
 * A hash cache persisted at `cachePath`. The file is read once, on the first
 * pass, and the cache keeps the result in memory for the passes after it.
 *
 * @example
 * const pass = createFileHashCache('.mango/pass-stamps/hashes.cache').startPass();
 * const sha = pass.hashOf('/repo/src/a.ts');
 * pass.commit();
 */
export function createFileHashCache(
  cachePath: string,
  options: FileHashCacheOptions = {}
): FileHashCache {
  const now = options.now ?? Date.now;
  const hashFile = options.hashFile ?? hashInputContent;
  let entries: Map<string, CacheEntry> | undefined;

  return {
    startPass() {
      // Sampled before any stat, so it is never later than a stat in this pass.
      const oldestTrusted = BigInt(Math.floor(now())) * 1_000_000n - RACY_WINDOW_NS;
      const known = (entries ??= loadEntries(cachePath));
      const used = new Map<string, CacheEntry>();

      return {
        hashOf(path) {
          let stat;
          try {
            stat = lstatSync(path, { bigint: true });
          } catch (caught) {
            const code = (caught as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') return null;
            throw caught;
          }
          if (!stat.isFile()) return hashFile(path);
          const size = stat.size.toString();
          const mtimeNs = stat.mtimeNs.toString();
          const ctimeNs = stat.ctimeNs.toString();
          const ino = stat.ino.toString();
          const cached = known.get(path);
          if (
            cached?.size === size &&
            cached.mtimeNs === mtimeNs &&
            cached.ctimeNs === ctimeNs &&
            cached.ino === ino
          ) {
            used.set(path, cached);
            return cached.sha256;
          }
          const sha256 = hashFile(path);
          if (sha256 !== null && stat.mtimeNs < oldestTrusted && stat.ctimeNs < oldestTrusted) {
            used.set(path, { size, mtimeNs, ctimeNs, ino, sha256 });
          }
          return sha256;
        },
        commit() {
          let changed = used.size !== known.size;
          for (const [path, entry] of used) changed ||= known.get(path) !== entry;
          if (!changed) return;
          entries = used;
          writeEntries(cachePath, used);
        },
      };
    },
  };
}
