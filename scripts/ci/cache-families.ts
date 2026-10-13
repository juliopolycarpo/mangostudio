import { parseRustCacheKey } from './rust-cache/families';

// All families written by cache-scoped. The policy receipt checks every call
// site against this registry, so adding a writer also updates accounting.
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

/** Account for an exact registered key, preserving unrelated entries as unknown. */
export function cacheFamily(key: string): string {
  const rust = parseRustCacheKey(key);
  if (rust) return `rust/${rust.family}`;
  const platform = PLATFORM.exec(key);
  if (!platform) return 'unknown';
  const scoped = key.slice(platform[0].length);
  const candidates = [...scoped.matchAll(SCOPED_FAMILY)].filter((match) =>
    EPOCH.test(scoped.slice(0, match.index))
  );
  // Epoch and validity can both contain hyphens. If either contains another
  // family/scope boundary, the wire key cannot establish its owner uniquely.
  return candidates.length === 1 ? candidates[0][1] : 'unknown';
}
