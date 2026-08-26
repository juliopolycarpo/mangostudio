/**
 * Reduces gh's `statusCheckRollup` to the four counters the panel renders.
 *
 * `gh pr list --json statusCheckRollup` returns the *full per-check array on
 * every row*. On a repository with a dozen workflows that is hundreds of
 * objects per page, of which the list view shows four integers — so the array
 * is reduced here, next to `gh`, and never crosses the API boundary.
 *
 * Two GraphQL variants arrive in the same array, and both occur against this
 * repository. A reducer that only knows `CheckRun` reports a fully green pull
 * request as having no checks, because third-party bots report through the
 * other one. That failure is silent, which is why it is unit-tested against a
 * mixed array rather than trusted.
 */

import type { GithubCheckSummary } from '@mangostudio/shared/github';

/**
 * The shape gh actually emits per rollup entry, as far as counting needs it.
 *
 * Deliberately permissive: this is a foreign vocabulary that GitHub versions,
 * arriving through a CLI that adds fields. Anything unrecognised counts toward
 * `total` and no bucket, which is also how a genuinely neutral check should be
 * reported.
 */
interface RollupEntry {
  readonly __typename?: string;
  /** `CheckRun`: QUEUED / IN_PROGRESS / COMPLETED. */
  readonly status?: string;
  /** `CheckRun`: SUCCESS / FAILURE / SKIPPED / NEUTRAL / CANCELLED / ... */
  readonly conclusion?: string;
  /** `StatusContext`: SUCCESS / FAILURE / PENDING / ERROR / EXPECTED. */
  readonly state?: string;
}

type Bucket = 'passed' | 'failed' | 'pending' | null;

const CHECK_RUN_CONCLUSIONS: Readonly<Record<string, Bucket>> = {
  SUCCESS: 'passed',
  FAILURE: 'failed',
  TIMED_OUT: 'failed',
  ACTION_REQUIRED: 'failed',
  STARTUP_FAILURE: 'failed',
  // SKIPPED, NEUTRAL, CANCELLED and STALE deliberately have no bucket: they are
  // real entries that neither passed nor failed nor are still running.
};

const STATUS_CONTEXT_STATES: Readonly<Record<string, Bucket>> = {
  SUCCESS: 'passed',
  FAILURE: 'failed',
  ERROR: 'failed',
  PENDING: 'pending',
  // EXPECTED means a required context GitHub has been told to wait for and has
  // not heard from, which is the same thing a person reads as "still running".
  EXPECTED: 'pending',
};

/**
 * Counts one rollup array into `{passed, failed, pending, total}`.
 *
 * `total` is carried rather than derived: skipped, neutral and cancelled checks
 * belong to no bucket, so `passed + failed + pending` is legitimately less than
 * `total` and a client that recomputed it would be wrong.
 *
 * @example
 * summarizeCheckRollup([
 *   { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
 *   { __typename: 'StatusContext', state: 'PENDING' },
 * ]); // { passed: 1, failed: 0, pending: 1, total: 2 }
 */
export function summarizeCheckRollup(rollup: readonly unknown[]): GithubCheckSummary {
  const counts = { passed: 0, failed: 0, pending: 0, total: rollup.length };
  for (const entry of rollup) {
    const bucket = bucketOf(entry as RollupEntry);
    if (bucket) counts[bucket] += 1;
  }
  return counts;
}

/**
 * The same reduction for a row whose rollup may be absent.
 *
 * `null` and an empty array are different answers and stay different: `null`
 * means "this pull request has no CI at all", while `{total: 0}` means the
 * rollup came back empty for one that does — the panel shows "waiting" for the
 * second and nothing for the first.
 *
 * @example
 * summarizeOptionalCheckRollup(undefined); // null
 * summarizeOptionalCheckRollup([]); // { passed: 0, failed: 0, pending: 0, total: 0 }
 */
export function summarizeOptionalCheckRollup(rollup: unknown): GithubCheckSummary | null {
  if (!Array.isArray(rollup)) return null;
  return summarizeCheckRollup(rollup);
}

/**
 * The same four counters from `gh pr checks` rows, which carry gh's own bucket.
 *
 * Not a second opinion: `bucket` is documented as "categorizes the `state`
 * field into pass, fail, pending, skipping, or cancel", computed by gh from the
 * very rollup `summarizeCheckRollup` reduces. Counting it here rather than
 * fetching `statusCheckRollup` a second time keeps the checks endpoint to one
 * round trip, and the two functions live in one module — with a test pinning
 * that they agree — so "how a check is counted" stays a single decision.
 *
 * @example
 * summarizeCheckBuckets([{ bucket: 'pass' }, { bucket: 'skipping' }]);
 * // { passed: 1, failed: 0, pending: 0, total: 2 }
 */
export function summarizeCheckBuckets(
  rows: readonly { readonly bucket: string }[]
): GithubCheckSummary {
  const counts = { passed: 0, failed: 0, pending: 0, total: rows.length };
  for (const row of rows) {
    const bucket = BUCKET_COUNTERS[row.bucket];
    if (bucket) counts[bucket] += 1;
  }
  return counts;
}

/** `skipping` and `cancel` are absent on purpose: they count toward `total` only. */
const BUCKET_COUNTERS: Readonly<Record<string, Bucket>> = {
  pass: 'passed',
  fail: 'failed',
  pending: 'pending',
};

/** Picks a bucket from whichever of the two variants this entry is. */
function bucketOf(entry: RollupEntry): Bucket {
  if (entry.__typename === 'StatusContext') return STATUS_CONTEXT_STATES[entry.state ?? ''] ?? null;
  // Everything else is treated as a CheckRun, including an entry whose
  // `__typename` gh did not select: a check run is what the field is for, and
  // guessing wrong here only costs a bucket, never a miscount of `total`.
  if (entry.status !== undefined && entry.status !== 'COMPLETED') return 'pending';
  return CHECK_RUN_CONCLUSIONS[entry.conclusion ?? ''] ?? null;
}
