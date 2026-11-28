import { parseRustCacheKey } from './rust-cache/families';

// All families written by cache-scoped. The policy receipt checks every call
// site against this registry, so adding a writer also updates accounting.
// `bun` is retired (setup-mango no longer transfers a package cache) and stays
// only so entries still inside the 14-day retention are not reported as unknown.
export const SCOPED_CACHE_FAMILIES = [
  'bun',
  'turbo',
  'lint-tools',
  'playwright',
  'timings',
] as const;

const PLATFORM = /^(Linux|macOS|Windows)-(X64|ARM64|X86|ARM)-/;
const EPOCH = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SCOPED_FAMILY = new RegExp(
  `(?=-(${SCOPED_CACHE_FAMILIES.join('|')})-(main|pr-[1-9][0-9]*|run-[1-9][0-9]*)-([^-]+(?:-[^-]+)*$))`,
  'g'
);

/** The parts of a key `cache-scoped` wrote: `<os>-<arch>-<epoch>-<family>-<scope>-<validity>`. */
export interface ScopedCacheKey {
  /** Runner OS and architecture, e.g. `Linux-X64`. */
  readonly platform: string;
  readonly epoch: string;
  readonly family: string;
  /** `main`, `pr-<N>` or `run-<id>`. */
  readonly scope: string;
  readonly validity: string;
}

/**
 * Split a `cache-scoped` key, or return undefined when the wire key cannot
 * establish one owner uniquely.
 * @example parseScopedCacheKey('Linux-X64-v1-timings-main-test-shard-2-42')?.scope; // 'main'
 */
export function parseScopedCacheKey(key: string): ScopedCacheKey | undefined {
  const platform = PLATFORM.exec(key);
  if (!platform) return undefined;
  const scoped = key.slice(platform[0].length);
  const candidates = [...scoped.matchAll(SCOPED_FAMILY)].filter((match) =>
    EPOCH.test(scoped.slice(0, match.index))
  );
  // Epoch and validity can both contain hyphens. If either contains another
  // family/scope boundary, the wire key cannot establish its owner uniquely.
  if (candidates.length !== 1) return undefined;
  const [match] = candidates;
  return {
    platform: platform[0].slice(0, -1),
    epoch: scoped.slice(0, match.index),
    family: match[1],
    scope: match[2],
    validity: match[3],
  };
}

/** Account for an exact registered key, preserving unrelated entries as unknown. */
export function cacheFamily(key: string): string {
  const rust = parseRustCacheKey(key);
  if (rust) return `rust/${rust.family}`;
  return parseScopedCacheKey(key)?.family ?? 'unknown';
}
