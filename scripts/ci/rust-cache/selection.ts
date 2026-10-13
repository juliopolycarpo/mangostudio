import { MAIN_CACHE_REF, parseRustCacheKey } from './families';

export interface RustCacheEntry {
  readonly id: number;
  readonly key: string;
  readonly ref: string;
  readonly version: string;
  readonly created_at: string;
  readonly size_in_bytes: number;
}

export interface RustCacheDeletion {
  readonly entry: RustCacheEntry;
  readonly replacement: RustCacheEntry;
}

function familyIdentity(entry: RustCacheEntry): string | undefined {
  if (
    !Number.isSafeInteger(entry.id) ||
    entry.id < 1 ||
    !Number.isSafeInteger(entry.size_in_bytes) ||
    entry.size_in_bytes < 1
  )
    return;
  if (entry.ref !== MAIN_CACHE_REF || !/^[a-f0-9]{64}$/.test(entry.version)) return;
  const parsed = parseRustCacheKey(entry.key);
  if (!parsed) return;
  const { family, os, arch, environment } = parsed;
  // Preserve the cache archive version as well as the compiler/environment,
  // platform, target and profile. Only manifest/dependency generations rotate.
  return [family, os, arch, environment, entry.version].join(':');
}

function olderGenerations(entries: readonly RustCacheEntry[]): RustCacheDeletion[] {
  if (entries.length < 2) return [];
  if (entries.some((entry) => !Number.isFinite(Date.parse(entry.created_at)))) return [];
  const sorted = [...entries].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const replacement = sorted[0];
  // Equal timestamps and duplicate generations cannot establish which entry
  // replaced which. Keep the entire group rather than choosing an arbitrary ID.
  if (Date.parse(replacement.created_at) === Date.parse(sorted[1].created_at)) return [];
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) return [];
  return sorted.slice(1).map((entry) => ({ entry, replacement }));
}

/**
 * Select older committed generations only when a replacement exists.
 * @example selectRustCacheDeletions(listing);
 */
export function selectRustCacheDeletions(entries: readonly RustCacheEntry[]): RustCacheDeletion[] {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) return [];
  const families = new Map<string, RustCacheEntry[]>();
  for (const entry of entries) {
    const identity = familyIdentity(entry);
    if (!identity) continue;
    const family = families.get(identity) ?? [];
    family.push(entry);
    families.set(identity, family);
  }
  return [...families.values()].flatMap(olderGenerations);
}
