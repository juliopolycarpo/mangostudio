/**
 * Matching local branches to the pull requests they were opened as.
 *
 * This reports whether the pull request merged, not whether deleting the
 * local branch is safe: `gh pr list` reports a PR's state, not whether the
 * branch's current tip is an ancestor of it, and a branch can carry commits
 * added after the PR merged that Git itself has never seen land anywhere.
 * `git branch -d` is the actual safety check — it refuses an unmerged tip and
 * a caller reads that refusal before offering `--force` — so this annotation
 * stays a hint about the pull request, not a verdict on the branch. That is
 * why the annotation reads the `all` filter and why `all` exists in the
 * contract at all: `open`, `mine` and `review-requested` every one resolve to
 * `--state=open`, so under any of them a merged branch and a branch that never
 * had a pull request look identical.
 */

import type { GithubPrState, GithubPrSummary } from '@mangostudio/shared/github';

export interface BranchPrAnnotation {
  readonly number: number;
  readonly state: GithubPrState;
  readonly url: string;
  readonly isDraft: boolean;
  /** True only for `MERGED`. Not a claim that the branch's tip is merged too. */
  readonly isMerged: boolean;
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
 * annotateBranchesWithPrs(prs).get('feat/github-panel')?.isMerged; // true
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
      isMerged: pr.state === 'MERGED',
    });
  }

  return byBranch;
}
