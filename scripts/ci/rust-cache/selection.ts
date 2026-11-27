import type { ActionsCacheEntry } from '../actions-api/client';
import { MAIN_CACHE_REF, parseRustCacheKey } from './families';

export type RustCacheEntry = ActionsCacheEntry;

export interface RustCacheDeletion {
  readonly entry: RustCacheEntry;
  readonly replacement: RustCacheEntry;
}

/** A committed main-ref entry whose key is a known Rust family, or nothing. */
function readEntry(entry: RustCacheEntry): ReturnType<typeof parseRustCacheKey> {
  if (
    !Number.isSafeInteger(entry.id) ||
    entry.id < 1 ||
    !Number.isSafeInteger(entry.size_in_bytes) ||
    entry.size_in_bytes < 1
  )
    return;
  if (entry.ref !== MAIN_CACHE_REF || !/^[a-f0-9]{64}$/.test(entry.version)) return;
  return parseRustCacheKey(entry.key);
}

function familyIdentity(entry: RustCacheEntry): string | undefined {
  const parsed = readEntry(entry);
  if (!parsed) return;
  const { generation, family, os, arch, environment } = parsed;
  // Preserve the cache archive version as well as the compiler/environment,
  // platform, target and profile. Only manifest/dependency generations rotate.
  // The key generation is part of the identity so a late save by an older
  // workflow revision can never count as the replacement of a current entry.
  return [generation, family, os, arch, environment, entry.version].join(':');
}

// The environment hash is left out: pruning the runner image's toolchain moved it for every family
// at once, so a manifest-generation entry never shares an environment with its profile-generation
// successor. What must match is what the entry was for.
function platformIdentity(entry: RustCacheEntry): string | undefined {
  const parsed = readEntry(entry);
  if (!parsed) return;
  return [parsed.family, parsed.os, parsed.arch, entry.version].join(':');
}

/**
 * Entries of the retired `v0-rust-<hashFiles('Cargo.toml')>` generation. No workflow restores that
 * prefix any more, so each one is dead weight once a profile-generation entry exists for the same
 * family, runner and archive version. Until one does, the entry stays: it is the only warm copy
 * an in-flight run on an older workflow revision could still read.
 */
function retiredManifestGenerations(entries: readonly RustCacheEntry[]): RustCacheDeletion[] {
  const successors = new Map<string, RustCacheEntry>();
  const retired: RustCacheEntry[] = [];
  for (const entry of entries) {
    const identity = platformIdentity(entry);
    if (!identity) continue;
    if (readEntry(entry)?.generation === 'manifest') {
      retired.push(entry);
      continue;
    }
    const known = successors.get(identity);
    // A malformed timestamp parses to NaN, which loses every comparison: such an entry is only
    // chosen when it is the sole successor.
    if (!known || Date.parse(entry.created_at) > Date.parse(known.created_at)) {
      successors.set(identity, entry);
    }
  }
  return retired.flatMap((entry) => {
    const replacement = successors.get(platformIdentity(entry) ?? '');
    return replacement ? [{ entry, replacement }] : [];
  });
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
  const superseded = [...families.values()].flatMap(olderGenerations);
  // An entry both rules select is deleted once.
  const planned = new Set(superseded.map(({ entry }) => entry.id));
  const retired = retiredManifestGenerations(entries).filter(({ entry }) => !planned.has(entry.id));
  return [...superseded, ...retired];
}
