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
    this.instanceHashes.set(path, { fingerprint, value });
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
    this.scans.set(signature, { scannedAtMs: nowMs, value });
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
