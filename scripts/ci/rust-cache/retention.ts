import { parseScopedCacheKey } from '../cache-families';
import { MAIN_CACHE_REF } from './families';
import type { RustCacheDeletion, RustCacheEntry } from './selection';

// Retention for the main-scope `cache-scoped` families the Rust rule does not read.
//
// `actions/cache` restores one entry per restore prefix: the newest whose key starts with it.
// These families save a fresh key per run (`<run id>-<attempt>` or a bare run id), so every entry
// but the newest of a restore prefix is dead weight, and nothing else ever removes it.
//
// Each rule names the restore prefix it keeps entries for ("lane"). Grouping is deliberately
// coarser than the exact validity segment: the turbo validity embeds the Bun canary revision, which
// changes with almost every run, so grouping on it would keep the newest entry of every revision
// ever seen. Grouping on the loose prefix the workflows pass as `restore-prefix` (`build-`,
// `check-`, `test-`) keeps the newest few entries overall, and a run whose exact validity has no
// entry falls back to exactly that loose prefix.
//
// The epoch and the archive version are not part of the group either. A bump of
// `CI_CACHE_EPOCH` invalidates every older entry on purpose, so entries of an older epoch must
// compete with the new ones by age instead of forming a group that never shrinks.

/** Newest entries kept per lane. See `docs/reference/testing.md` ("Retention for other main caches"). */
export const RETENTION_KEEP = 3;
/** An entry written or restored within this window is never deleted. */
export const RETENTION_QUIET_MS = 60 * 60 * 1000;
/**
 * Retention deletions one cleanup run attempts, oldest first. Every deletion costs about ten API
 * requests (the writer audit, two listings and the DELETE) against the workflow token's 1,000
 * requests per hour, so a first run over a large backlog stops here and the next run continues.
 */
export const RETENTION_DELETIONS_PER_RUN = 25;

interface RetentionRule {
  readonly family: string;
  /** The restore lane of a validity, or undefined when the validity is outside the grammar. */
  readonly lane: (validity: string) => string | undefined;
  /** The validity grammar, for the error that names an unrecognised key. */
  readonly expected: string;
}

// The Bun and Turbo versions may carry hyphens (`1.4.6-canary.1+<sha>`, a Turbo pre-release), so
// only the lane head and the `<sha256>[-<run>-<attempt>]` tail are pinned. Two retired shapes stay
// recognisable so they are pruned instead of failing the run: the `test` lane (test.yml carries no
// Turbo cache) and the keys written before rotation, which have no run suffix.
const TURBO_VALIDITY =
  /^(build|check|test)-bun-.+-turbo-.+-[a-f0-9]{64}(?:-[1-9][0-9]*-[1-9][0-9]*)?$/;
const TIMINGS_VALIDITY = /^test-shard-[1-9][0-9]*-[1-9][0-9]*$/;
const LINT_TOOLS_VALIDITY = /^[a-f0-9]{64}$/;

export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    family: 'turbo',
    lane: (validity) => TURBO_VALIDITY.exec(validity)?.[1],
    expected: 'build|check|test-bun-<version>-turbo-<version>-<sha256>[-<run id>-<attempt>]',
  },
  {
    family: 'timings',
    lane: (validity) => (TIMINGS_VALIDITY.test(validity) ? 'test' : undefined),
    expected: 'test-shard-<count>-<run id>',
  },
  {
    family: 'lint-tools',
    lane: (validity) => (LINT_TOOLS_VALIDITY.test(validity) ? 'tools' : undefined),
    expected: '<sha256 of the lint tool manifest>',
  },
];

const RULES_BY_FAMILY = new Map(RETENTION_RULES.map((rule) => [rule.family, rule]));
// A main-scope key of a named family, by the literal alone, so a key the grammar cannot read
// still reaches the error below instead of being skipped.
const NAMED_MAIN_FAMILY = new RegExp(
  `^(?:Linux|macOS|Windows)-(?:X64|ARM64|X86|ARM)-.*-(${RETENTION_RULES.map((rule) => rule.family).join('|')})-main-`
);

function timestamp(entry: RustCacheEntry, field: 'created_at' | 'last_accessed_at'): number {
  const text = entry[field];
  const value = Date.parse(text ?? '');
  if (!Number.isFinite(value)) {
    throw new Error(
      `Invalid ${field} ${JSON.stringify(text)} on cache ${entry.id} ${entry.key}; expected an ISO 8601 timestamp`
    );
  }
  return value;
}

interface Lane {
  readonly entries: RustCacheEntry[];
}

/**
 * The lane an entry belongs to, undefined when no rule names it, and a thrown error when a rule
 * names its family but not its key.
 */
function laneOf(entry: RustCacheEntry): string | undefined {
  if (entry.ref !== MAIN_CACHE_REF) return undefined;
  const named = NAMED_MAIN_FAMILY.exec(entry.key)?.[1];
  if (!named) return undefined;
  const parsed = parseScopedCacheKey(entry.key);
  const rule = RULES_BY_FAMILY.get(named);
  const lane =
    parsed?.family === named && parsed.scope === 'main' ? rule?.lane(parsed.validity) : undefined;
  if (!parsed || lane === undefined) {
    throw new Error(
      `Unrecognised cache key ${JSON.stringify(entry.key)} (id ${entry.id}) in retained family ${named}; expected <os>-<arch>-<epoch>-${named}-main-${rule?.expected}`
    );
  }
  return `${parsed.platform}|${named}|${lane}`;
}

/**
 * Entries beyond the newest `RETENTION_KEEP` of their lane, oldest first, each paired with the
 * newest entry of the lane. Nothing is selected for an entry that was written or restored within
 * `RETENTION_QUIET_MS` of `now`, a ref other than main or a family no rule names. An unrecognised
 * key in a named family, or an unreadable timestamp, throws before anything can be deleted.
 * @example selectRetentionDeletions(listing, Date.now());
 */
export function selectRetentionDeletions(
  entries: readonly RustCacheEntry[],
  now: number
): RustCacheDeletion[] {
  const lanes = new Map<string, Lane>();
  for (const entry of entries) {
    const lane = laneOf(entry);
    if (lane === undefined) continue;
    const known = lanes.get(lane) ?? { entries: [] };
    known.entries.push(entry);
    lanes.set(lane, known);
  }
  const planned: RustCacheDeletion[] = [];
  for (const { entries: members } of lanes.values()) {
    const created = new Map(members.map((entry) => [entry.id, timestamp(entry, 'created_at')]));
    const newestFirst = [...members].sort(
      (a, b) => (created.get(b.id) ?? 0) - (created.get(a.id) ?? 0) || b.id - a.id
    );
    const replacement = newestFirst[0];
    for (const entry of newestFirst.slice(RETENTION_KEEP)) {
      const lastUsed = Math.max(
        created.get(entry.id) ?? 0,
        entry.last_accessed_at === undefined ? 0 : timestamp(entry, 'last_accessed_at')
      );
      if (now - lastUsed < RETENTION_QUIET_MS) continue;
      planned.push({ entry, replacement });
    }
  }
  return planned.sort(
    (a, b) =>
      Date.parse(a.entry.created_at) - Date.parse(b.entry.created_at) || a.entry.id - b.entry.id
  );
}
