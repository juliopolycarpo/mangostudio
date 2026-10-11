import { MAIN_CACHE_REF, RUST_CACHE_FAMILIES } from './families';

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

// Grammar from Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6
// src/config.ts: prefix + shared-key (or key + job) + os.type() + os.arch()
// + 8-hex rust/environment hash + 8-hex dependency hash. hashFiles(Cargo.toml)
// supplies the first 64-hex segment. No segment is guessed from a loose prefix.
// https://github.com/Swatinem/rust-cache/blob/6323deb102c322ba6fcbdcafc7e3dddab59af2b6/src/config.ts
const KEY_GRAMMAR =
  /^v0-rust-([a-f0-9]{64})-([a-z0-9-]+)-(Linux|Darwin|Windows_NT)-(x64|arm64)-([a-f0-9]{8})-([a-f0-9]{8})$/;
const KNOWN_FAMILIES = new Set<string>(RUST_CACHE_FAMILIES);

function familyIdentity(entry: RustCacheEntry): string | undefined {
  if (
    !Number.isSafeInteger(entry.id) ||
    entry.id < 1 ||
    !Number.isSafeInteger(entry.size_in_bytes) ||
    entry.size_in_bytes < 1
  )
    return;
  if (entry.ref !== MAIN_CACHE_REF || !/^[a-f0-9]{64}$/.test(entry.version)) return;
  const match = KEY_GRAMMAR.exec(entry.key);
  if (!match || !KNOWN_FAMILIES.has(match[2])) return;
  const [, , family, os, arch, environment] = match;
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
