/**
 * Matching branches to their pull requests, and whether that pull request
 * merged. Not whether deleting the branch is safe — see branch-pr-annotation.ts.
 */

import { describe, expect, it } from 'bun:test';
import type { GithubPrState, GithubPrSummary } from '@mangostudio/shared/github';
import { annotateBranchesWithPrs } from '../../../../src/features/github/lib/branch-pr-annotation';

function pr(number: number, headRefName: string, state: GithubPrState): GithubPrSummary {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/mango/studio/pull/${number}`,
    state,
    isDraft: false,
    headRefName,
    baseRefName: 'main',
    updatedAt: '2026-08-25T00:00:00Z',
    author: { login: 'alice' },
    labels: [],
    reviewDecision: null,
    checks: null,
  };
}

describe('annotateBranchesWithPrs', () => {
  it('indexes pull requests by their head branch', () => {
    const annotations = annotateBranchesWithPrs([pr(942, 'feat/github-panel', 'OPEN')]);

    expect(annotations.get('feat/github-panel')?.number).toBe(942);
    expect(annotations.get('feat/github-panel')?.url).toBe(
      'https://github.com/mango/studio/pull/942'
    );
  });

  it('marks only a merged pull request as merged', () => {
    const annotations = annotateBranchesWithPrs([
      pr(1, 'merged-branch', 'MERGED'),
      pr(2, 'open-branch', 'OPEN'),
      pr(3, 'closed-branch', 'CLOSED'),
    ]);

    expect(annotations.get('merged-branch')?.isMerged).toBe(true);
    expect(annotations.get('open-branch')?.isMerged).toBe(false);
    // Closed-without-merging is the case that matters: the work is *not* in the
    // base branch.
    expect(annotations.get('closed-branch')?.isMerged).toBe(false);
  });

  it('keeps the highest-numbered pull request when a branch has several', () => {
    // A branch somebody merged, deleted, and then pushed to again. The old
    // merged pull request must not mark the live branch as spent.
    const annotations = annotateBranchesWithPrs([
      pr(10, 'feat/x', 'MERGED'),
      pr(20, 'feat/x', 'OPEN'),
    ]);

    expect(annotations.get('feat/x')?.number).toBe(20);
    expect(annotations.get('feat/x')?.isMerged).toBe(false);
  });

  it('picks the newest whichever order the list arrives in', () => {
    const annotations = annotateBranchesWithPrs([
      pr(20, 'feat/x', 'OPEN'),
      pr(10, 'feat/x', 'MERGED'),
    ]);

    expect(annotations.get('feat/x')?.number).toBe(20);
  });

  it('leaves a branch with no pull request unannotated', () => {
    const annotations = annotateBranchesWithPrs([pr(1, 'feat/x', 'OPEN')]);

    expect(annotations.get('main')).toBeUndefined();
    expect(annotateBranchesWithPrs([]).size).toBe(0);
  });
});
