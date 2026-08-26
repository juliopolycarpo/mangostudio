/**
 * Matching local branches to the pull requests they were opened as.
 *
 * The question this answers is "is deleting this branch safe" — and it is only
 * answerable with `MERGED`, which no open-PR view can report. That is why the
 * annotation reads the `all` filter and why `all` exists in the contract at
 * all: `open`, `mine` and `review-requested` every one resolve to
 * `--state=open`, so under any of them a merged branch and a branch that never
 * had a pull request look identical.
 */

import type { GithubPrState, GithubPrSummary } from '@mangostudio/shared/github';

export interface BranchPrAnnotation {
  readonly number: number;
  readonly state: GithubPrState;
  readonly url: string;
  readonly isDraft: boolean;
  /** True only for `MERGED`: the one state in which the local branch is spent. */
  readonly safeToDelete: boolean;
}

/**
 * Indexes pull requests by head branch, newest-numbered first.
 *
 * A branch can carry more than one pull request over its life — a closed one
 * and a reopened one, or a merged one on a branch somebody pushed to again.
 * The highest number is the most recent, and the most recent is the one whose
 * state describes the branch as it stands now. Picking arbitrarily would let a
 * long-closed pull request mark a live branch as safe to delete.
 *
 * Bounded by the list's own 30-row cap, so this covers *recent* pull requests
 * rather than every one the repository has ever had. A branch older than the
 * last thirty simply goes unannotated, which reads the same as having no pull
 * request — the conservative direction, since it withholds "safe to delete"
 * rather than inventing it.
 *
 * @example
 * annotateBranchesWithPrs(prs).get('feat/github-panel')?.safeToDelete; // true
 */
export function annotateBranchesWithPrs(
  prs: readonly GithubPrSummary[]
): ReadonlyMap<string, BranchPrAnnotation> {
  const byBranch = new Map<string, BranchPrAnnotation>();

  for (const pr of prs) {
    const existing = byBranch.get(pr.headRefName);
    if (existing && existing.number > pr.number) continue;
    byBranch.set(pr.headRefName, {
      number: pr.number,
      state: pr.state,
      url: pr.url,
      isDraft: pr.isDraft,
      safeToDelete: pr.state === 'MERGED',
    });
  }

  return byBranch;
}
