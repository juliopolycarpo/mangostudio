import type { LibraryInvalidReason, LibraryResource } from '@mangostudio/shared/library';

export interface CachedInstanceDisplay {
  readonly title?: string;
  readonly description?: string;
  readonly invalidReason?: LibraryInvalidReason;
}

export interface CachedInstanceHash {
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly whitespaceHash: string;
  readonly display: CachedInstanceDisplay;
}

interface InstanceHashEntry {
  readonly fingerprint: string;
  readonly value: Promise<CachedInstanceHash>;
}

interface ScanEntry {
  readonly scannedAtMs: number;
  readonly value: Promise<LibraryResource[]>;
}

export const LIBRARY_SCAN_CACHE_TTL_MS = 2_000;

/**
 * Neither level expires by itself: a hash entry for a deleted path and a scan
 * for a location set nobody asks for again would otherwise live as long as the
 * process. Both are keyed by insertion order, so evicting the oldest entry
 * costs a rehash at worst.
 */
const MAX_INSTANCE_HASH_ENTRIES = 4_096;
const MAX_SCAN_ENTRIES = 32;

function setBounded<K, V>(entries: Map<K, V>, key: K, value: V, maxEntries: number): void {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/**
 * Keeps byte hashes stable across scans and coalesces concurrent matrix loads.
 * A forced rescan replaces both entries instead of serving either cache level.
 */
export class LibraryCache {
  private readonly instanceHashes = new Map<string, InstanceHashEntry>();
  private readonly scans = new Map<string, ScanEntry>();

  getOrComputeInstanceHash(
    path: string,
    fingerprint: string,
    force: boolean,
    compute: () => Promise<CachedInstanceHash>
  ): Promise<CachedInstanceHash> {
    const cached = this.instanceHashes.get(path);
    if (!force && cached?.fingerprint === fingerprint) return cached.value;

    const value = compute();
    setBounded(this.instanceHashes, path, { fingerprint, value }, MAX_INSTANCE_HASH_ENTRIES);
    void value.catch(() => {
      if (this.instanceHashes.get(path)?.value === value) this.instanceHashes.delete(path);
    });
    return value;
  }

  getOrComputeScan(
    signature: string,
    nowMs: number,
    force: boolean,
    compute: () => Promise<LibraryResource[]>
  ): Promise<LibraryResource[]> {
    const cached = this.scans.get(signature);
    if (!force && cached && nowMs - cached.scannedAtMs < LIBRARY_SCAN_CACHE_TTL_MS) {
      return cached.value;
    }

    // Signatures partition by enabled locations, resolved paths, and requested
    // kinds, so the rescan route's signature is rarely the one a given consumer
    // (the skill adapter, the matrix UI) reads. Dropping every memo keeps
    // "force" globally authoritative instead of refreshing one arbitrary slice.
    if (force) this.scans.clear();

    const value = compute();
    setBounded(this.scans, signature, { scannedAtMs: nowMs, value }, MAX_SCAN_ENTRIES);
    void value.catch(() => {
      if (this.scans.get(signature)?.value === value) this.scans.delete(signature);
    });
    return value;
  }

  clear(): void {
    this.instanceHashes.clear();
    this.scans.clear();
  }
}

export const libraryCache = new LibraryCache();
