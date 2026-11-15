import type { ActionsCacheEntry } from '../actions-api/client';

export type PullRequestState = 'open' | 'closed';

const MERGE_REF = /^refs\/pull\/([1-9][0-9]*)\/merge$/;
const PULL_REQUEST_NUMBER = /^[1-9][0-9]*$/;

/**
 * Accept only a positive decimal integer: no sign, no leading zero, no suffix,
 * no whitespace. The number becomes part of a ref, so nothing else may pass.
 * @example parsePullRequestNumber('2222'); // 2222
 */
export function parsePullRequestNumber(value: string): number {
  const number = Number(value);
  if (!PULL_REQUEST_NUMBER.test(value) || !Number.isSafeInteger(number)) {
    throw new Error(
      `Invalid pull request number ${JSON.stringify(value)}; expected a positive integer such as 2222`
    );
  }
  return number;
}

/**
 * The only ref a pull request's per-PR caches are saved under.
 * @example pullRequestMergeRef(2222); // 'refs/pull/2222/merge'
 */
export function pullRequestMergeRef(pullRequest: number): string {
  return `refs/pull/${parsePullRequestNumber(String(pullRequest))}/merge`;
}

/**
 * Read the pull request number out of an exact `refs/pull/<N>/merge` ref.
 * Branch refs, `refs/pull/<N>/head` and anything else return undefined.
 * @example pullRequestNumberOfRef('refs/pull/7/merge'); // 7
 */
export function pullRequestNumberOfRef(ref: string): number | undefined {
  const match = MERGE_REF.exec(ref);
  return match ? Number(match[1]) : undefined;
}

/**
 * Keep the entries saved under exactly this pull request's merge ref. The API
 * `ref` filter already scopes the listing; matching again here means a loose
 * or changed filter can never widen the deletion.
 * @example selectPullRequestCaches(listing, 2222);
 */
export function selectPullRequestCaches(
  entries: readonly ActionsCacheEntry[],
  pullRequest: number
): ActionsCacheEntry[] {
  const ref = pullRequestMergeRef(pullRequest);
  return entries.filter((entry) => entry.ref === ref);
}

/**
 * Distinct pull request numbers that own at least one merge-ref cache, ascending.
 * @example pullRequestNumbers(listing); // [101, 2222]
 */
export function pullRequestNumbers(entries: readonly ActionsCacheEntry[]): number[] {
  const numbers = new Set<number>();
  for (const entry of entries) {
    const number = pullRequestNumberOfRef(entry.ref);
    if (number !== undefined) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * Keep the merge-ref entries of pull requests that are known to be closed. An
 * open pull request, one whose state is unknown and every non-merge ref stay.
 * @example selectClosedPullRequestCaches(listing, new Map([[7, 'closed']]));
 */
export function selectClosedPullRequestCaches(
  entries: readonly ActionsCacheEntry[],
  states: ReadonlyMap<number, PullRequestState>
): ActionsCacheEntry[] {
  return entries.filter((entry) => {
    const number = pullRequestNumberOfRef(entry.ref);
    return number !== undefined && states.get(number) === 'closed';
  });
}
