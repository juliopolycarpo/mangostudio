import { describe, expect, it } from 'bun:test';
import {
  GITHUB_LIST_LIMIT_DEFAULT,
  GithubActorSchema,
  GithubCheckBucketSchema,
  GithubCheckRunSchema,
  GithubCheckSummarySchema,
  GithubContextQuerySchema,
  GithubContextSchema,
  type GithubCreatePrBody,
  GithubCreatePrBodySchema,
  GithubCreatePrResponseSchema,
  type GithubInboxItem,
  GithubInboxItemSchema,
  GithubInboxQuerySchema,
  type GithubInboxResponse,
  GithubInboxResponseSchema,
  GithubIssueFilterSchema,
  GithubIssueStateSchema,
  GithubIssueSummarySchema,
  GithubIssuesQuerySchema,
  GithubIssuesResponseSchema,
  GithubLabelSchema,
  GithubLatestReviewSchema,
  GithubMergeableStateSchema,
  GithubMergeStateStatusSchema,
  GithubPrActionBodySchema,
  type GithubPrActionResponse,
  GithubPrActionResponseSchema,
  GithubPrChecksResponseSchema,
  GithubPrDetailResponseSchema,
  GithubPrDetailSchema,
  GithubPrFilterSchema,
  GithubPrRefQuerySchema,
  GithubPrSchema,
  GithubPrStateSchema,
  GithubPrSummarySchema,
  GithubPrsQuerySchema,
  type GithubPrsResponse,
  GithubPrsResponseSchema,
  GithubPrThreadsResponseSchema,
  GithubRepoSchema,
  GithubReviewDecisionSchema,
  GithubReviewStateSchema,
  GithubReviewThreadCommentSchema,
  GithubReviewThreadSchema,
  type GithubUnavailableState,
  GithubUnavailableStateSchema,
} from '@mangostudio/shared/github';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';

import { assertType, type Equals } from '../../src/test-utils/type-assert';

/**
 * The state union is the panel's one rendering contract. If a response's
 * `Static<>` ever collapses — the failure mode a `Value.Check` cannot see, since
 * the JSON Schema keeps validating — these assertions stop compiling.
 */
assertType<Equals<Extract<GithubPrsResponse, { state: 'ok' }>['cachedAt'], number>>();
assertType<Equals<GithubUnavailableState['state'], Exclude<GithubPrsResponse['state'], 'ok'>>>();

/**
 * The deliberate asymmetries, pinned where they can actually be enforced.
 * TypeBox objects are open at runtime, so `Value.Check` accepts an extra key
 * happily; only the derived type can say a field is absent by design.
 */
assertType<Equals<Extract<keyof GithubInboxItem, 'reviewDecision' | 'checks'>, never>>();
assertType<Equals<Extract<keyof Extract<GithubInboxResponse, { state: 'ok' }>, 'repo'>, never>>();
assertType<
  Equals<Extract<keyof Extract<GithubPrActionResponse, { state: 'ok' }>, 'cachedAt'>, never>
>();

const UNAVAILABLE_STATES = [
  'gh-not-installed',
  'not-authenticated',
  'no-remote',
  'not-a-github-remote',
] as const;

const repo = {
  nameWithOwner: 'mango/mangostudio',
  defaultBranch: 'main',
  url: 'https://github.example/mango/mangostudio',
};

const pr = {
  number: 42,
  title: 'Expose GitHub context',
  state: 'OPEN',
  isDraft: true,
  url: 'https://github.example/mango/mangostudio/pull/42',
  headRefName: 'feat/github-context',
  baseRefName: 'main',
};

const label = { name: 'area:api', color: 'c5def5' };
const actor = { login: 'octocat' };
const checks = { passed: 3, failed: 0, pending: 1, total: 5 };

const prSummary = {
  ...pr,
  updatedAt: '2026-08-25T10:00:00Z',
  author: actor,
  labels: [label],
  reviewDecision: 'REVIEW_REQUIRED',
  checks,
};

const prDetail = {
  number: 42,
  title: 'Expose GitHub context',
  body: 'Adds the panel contracts.',
  url: 'https://github.example/mango/mangostudio/pull/42',
  reviewDecision: 'APPROVED',
  mergeStateStatus: 'CLEAN',
  mergeable: 'MERGEABLE',
  changedFiles: 4,
  additions: 120,
  deletions: 8,
  latestReviews: [{ author: actor, state: 'APPROVED', body: 'ship it' }],
  labels: [label],
};

const checkRun = {
  name: 'unit',
  bucket: 'pass',
  state: 'SUCCESS',
  link: 'https://github.example/run/1',
  workflow: 'CI',
  description: '',
};

const reviewThread = {
  isResolved: false,
  isOutdated: false,
  path: 'apps/shared/src/github/schemas.ts',
  line: 12,
  comments: [{ author: actor, body: 'why closed here?' }],
};

const issue = {
  number: 7,
  title: 'Panel shows stale checks',
  url: 'https://github.example/mango/mangostudio/issues/7',
  state: 'OPEN',
  updatedAt: '2026-08-25T10:00:00Z',
  author: actor,
  labels: [label],
  assignees: [actor],
};

const inboxItem = {
  number: 91,
  title: 'Review requested elsewhere',
  url: 'https://github.example/other/repo/pull/91',
  state: 'OPEN',
  isDraft: false,
  updatedAt: '2026-08-25T10:00:00Z',
  author: actor,
  labels: [label],
  repository: { nameWithOwner: 'other/repo' },
};

/** Asserts a response union answers every unavailable state and rejects a made-up one. */
function expectUnavailableStates(schema: TSchema) {
  for (const state of UNAVAILABLE_STATES) {
    expect(Value.Check(schema, { state }), state).toBe(true);
  }
  expect(Value.Check(schema, { state: 'unsupported-environment' })).toBe(false);
}

describe('GitHub contracts', () => {
  it('validates repository and pull request data', () => {
    expect(Value.Check(GithubRepoSchema, repo)).toBe(true);
    expect(Value.Check(GithubPrSchema, pr)).toBe(true);
    expect(Value.Check(GithubPrSchema, { ...pr, state: 'UNKNOWN' })).toBe(false);
    expect(Value.Check(GithubPrSchema, { ...pr, number: 0 })).toBe(false);
  });

  it('distinguishes unavailable states from successful context', () => {
    expectUnavailableStates(GithubContextSchema);

    expect(Value.Check(GithubContextSchema, { state: 'ok', repo, pr })).toBe(true);
    expect(Value.Check(GithubContextSchema, { state: 'ok', repo, pr: null })).toBe(true);
    expect(Value.Check(GithubContextSchema, { state: 'ok', repo })).toBe(false);
  });

  it('requires a non-empty chat id', () => {
    expect(Value.Check(GithubContextQuerySchema, { chatId: 'chat-1' })).toBe(true);
    expect(Value.Check(GithubContextQuerySchema, { chatId: '' })).toBe(false);
  });
});

describe('GitHub row primitives', () => {
  it('accepts an actor with or without the bot flag', () => {
    expect(Value.Check(GithubActorSchema, actor)).toBe(true);
    expect(Value.Check(GithubActorSchema, { login: 'dependabot', isBot: true })).toBe(true);
    expect(Value.Check(GithubActorSchema, { isBot: true })).toBe(false);
  });

  it('keeps the label colour a bare string, since gh omits the leading hash', () => {
    expect(Value.Check(GithubLabelSchema, label)).toBe(true);
    expect(Value.Check(GithubLabelSchema, { name: 'bug', color: 'BFDADC' })).toBe(true);
    expect(Value.Check(GithubLabelSchema, { name: 'bug' })).toBe(false);
  });

  it('closes the pull request and issue state vocabularies', () => {
    for (const state of ['OPEN', 'CLOSED', 'MERGED']) {
      expect(Value.Check(GithubPrStateSchema, state), state).toBe(true);
    }
    // `gh search prs` emits lowercase; the API boundary upper-cases it so the
    // contract never carries two casings for one value.
    expect(Value.Check(GithubPrStateSchema, 'open')).toBe(false);
    expect(Value.Check(GithubIssueStateSchema, 'OPEN')).toBe(true);
    expect(Value.Check(GithubIssueStateSchema, 'MERGED')).toBe(false);
  });

  it('closes the review decision union and leaves "none" to null', () => {
    for (const decision of ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']) {
      expect(Value.Check(GithubReviewDecisionSchema, decision), decision).toBe(true);
    }
    expect(Value.Check(GithubReviewDecisionSchema, '')).toBe(false);
    expect(Value.Check(GithubReviewDecisionSchema, null)).toBe(false);

    expect(Value.Check(GithubPrSummarySchema, { ...prSummary, reviewDecision: null })).toBe(true);
    // gh's own empty-string spelling must not survive the boundary.
    expect(Value.Check(GithubPrSummarySchema, { ...prSummary, reviewDecision: '' })).toBe(false);
    const { reviewDecision: _omitted, ...withoutDecision } = prSummary;
    expect(Value.Check(GithubPrSummarySchema, withoutDecision)).toBe(false);
  });

  it('closes the per-review state union', () => {
    for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']) {
      expect(Value.Check(GithubReviewStateSchema, state), state).toBe(true);
    }
    expect(Value.Check(GithubReviewStateSchema, 'APPROVED_WITH_SUGGESTIONS')).toBe(false);
    expect(
      Value.Check(GithubLatestReviewSchema, { author: null, state: 'COMMENTED', body: '' })
    ).toBe(true);
  });

  it('closes the merge vocabularies gh takes from GitHub GraphQL enums', () => {
    for (const status of [
      'BEHIND',
      'BLOCKED',
      'CLEAN',
      'DIRTY',
      'DRAFT',
      'HAS_HOOKS',
      'UNKNOWN',
      'UNSTABLE',
    ]) {
      expect(Value.Check(GithubMergeStateStatusSchema, status), status).toBe(true);
    }
    expect(Value.Check(GithubMergeStateStatusSchema, 'MERGED')).toBe(false);

    for (const mergeable of ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']) {
      expect(Value.Check(GithubMergeableStateSchema, mergeable), mergeable).toBe(true);
    }
    expect(Value.Check(GithubMergeableStateSchema, 'DIRTY')).toBe(false);
  });
});

describe('GitHub check contracts', () => {
  it('counts checks with non-negative integers only', () => {
    expect(Value.Check(GithubCheckSummarySchema, checks)).toBe(true);
    expect(Value.Check(GithubCheckSummarySchema, { ...checks, failed: -1 })).toBe(false);
    expect(Value.Check(GithubCheckSummarySchema, { ...checks, pending: 1.5 })).toBe(false);
    expect(Value.Check(GithubCheckSummarySchema, { passed: 0, failed: 0, pending: 0 })).toBe(false);
  });

  it('closes the bucket union while leaving the provider verdict open', () => {
    for (const bucket of ['pass', 'fail', 'pending', 'skipping', 'cancel']) {
      expect(Value.Check(GithubCheckBucketSchema, bucket), bucket).toBe(true);
    }
    expect(Value.Check(GithubCheckBucketSchema, 'SUCCESS')).toBe(false);

    expect(Value.Check(GithubCheckRunSchema, checkRun)).toBe(true);
    // An unfamiliar provider verdict must not fail a read-only panel.
    expect(Value.Check(GithubCheckRunSchema, { ...checkRun, state: 'NEUTRAL' })).toBe(true);
    expect(Value.Check(GithubCheckRunSchema, { ...checkRun, bucket: 'flaky' })).toBe(false);
  });

  it('treats the timestamps as optional, since gh sends a zero date for unfinished runs', () => {
    const timed = {
      ...checkRun,
      startedAt: '2026-08-25T09:00:00Z',
      completedAt: '2026-08-25T09:03:00Z',
    };
    expect(Value.Check(GithubCheckRunSchema, timed)).toBe(true);
    expect(Value.Check(GithubCheckRunSchema, { ...checkRun, description: undefined })).toBe(false);
  });
});

describe('GitHub pull request and issue rows', () => {
  it('validates a repo-scoped pull request row', () => {
    expect(Value.Check(GithubPrSummarySchema, prSummary)).toBe(true);
    expect(Value.Check(GithubPrSummarySchema, { ...prSummary, author: null })).toBe(true);
    expect(Value.Check(GithubPrSummarySchema, { ...prSummary, checks: null })).toBe(true);
    expect(Value.Check(GithubPrSummarySchema, { ...prSummary, labels: [{ name: 'bug' }] })).toBe(
      false
    );
  });

  it('validates the detail shape', () => {
    expect(Value.Check(GithubPrDetailSchema, prDetail)).toBe(true);
    expect(Value.Check(GithubPrDetailSchema, { ...prDetail, changedFiles: -1 })).toBe(false);
    expect(Value.Check(GithubPrDetailSchema, { ...prDetail, mergeStateStatus: 'MERGED' })).toBe(
      false
    );
  });

  it('anchors a review thread to a file, and tolerates an outdated anchor', () => {
    expect(Value.Check(GithubReviewThreadSchema, reviewThread)).toBe(true);
    expect(
      Value.Check(GithubReviewThreadSchema, { ...reviewThread, isOutdated: true, line: null })
    ).toBe(true);
    expect(Value.Check(GithubReviewThreadSchema, { ...reviewThread, line: 0 })).toBe(false);
    expect(Value.Check(GithubReviewThreadCommentSchema, { author: null, body: 'x' })).toBe(true);
  });

  it('validates an issue row', () => {
    expect(Value.Check(GithubIssueSummarySchema, issue)).toBe(true);
    expect(Value.Check(GithubIssueSummarySchema, { ...issue, assignees: [] })).toBe(true);
    expect(Value.Check(GithubIssueSummarySchema, { ...issue, state: 'MERGED' })).toBe(false);
  });

  it('keeps inbox rows thinner than repo rows, because gh search cannot fill them', () => {
    expect(Value.Check(GithubInboxItemSchema, inboxItem)).toBe(true);
    expect(Value.Check(GithubInboxItemSchema, { ...inboxItem, repository: 'other/repo' })).toBe(
      false
    );
    const { repository: _dropped, ...withoutRepository } = inboxItem;
    expect(Value.Check(GithubInboxItemSchema, withoutRepository)).toBe(false);
  });
});

describe('GitHub query and body contracts', () => {
  it('closes the filter unions so user input never reaches argv', () => {
    for (const filter of ['open', 'mine', 'review-requested']) {
      expect(Value.Check(GithubPrFilterSchema, filter), filter).toBe(true);
    }
    expect(Value.Check(GithubPrFilterSchema, 'assigned')).toBe(false);
    expect(Value.Check(GithubPrFilterSchema, '--repo=attacker/evil')).toBe(false);

    for (const filter of ['open', 'assigned', 'mine']) {
      expect(Value.Check(GithubIssueFilterSchema, filter), filter).toBe(true);
    }
    expect(Value.Check(GithubIssueFilterSchema, 'review-requested')).toBe(false);
  });

  it('bounds the page size at both ends', () => {
    expect(Value.Check(GithubPrsQuerySchema, { chatId: 'chat-1', limit: 1 })).toBe(true);
    expect(Value.Check(GithubPrsQuerySchema, { chatId: 'chat-1', limit: 30 })).toBe(true);
    expect(Value.Check(GithubPrsQuerySchema, { chatId: 'chat-1', limit: 0 })).toBe(false);
    expect(Value.Check(GithubPrsQuerySchema, { chatId: 'chat-1', limit: 31 })).toBe(false);
    expect(GITHUB_LIST_LIMIT_DEFAULT).toBeGreaterThanOrEqual(1);
    expect(GITHUB_LIST_LIMIT_DEFAULT).toBeLessThanOrEqual(30);
  });

  it('scopes list queries to a chat, and the inbox to none', () => {
    expect(Value.Check(GithubPrsQuerySchema, { chatId: 'chat-1', filter: 'mine' })).toBe(true);
    expect(Value.Check(GithubPrsQuerySchema, { chatId: '' })).toBe(false);
    expect(Value.Check(GithubIssuesQuerySchema, { chatId: 'chat-1', filter: 'assigned' })).toBe(
      true
    );
    expect(
      Value.Check(GithubIssuesQuerySchema, { chatId: 'chat-1', filter: 'mine', limit: 5 })
    ).toBe(true);

    expect(Value.Check(GithubInboxQuerySchema, {})).toBe(true);
    expect(Value.Check(GithubInboxQuerySchema, { environmentId: 'env-1', limit: 10 })).toBe(true);
    expect(Value.Check(GithubInboxQuerySchema, { environmentId: '' })).toBe(false);
  });

  it('requires a chat and a positive number on every per-PR read', () => {
    expect(Value.Check(GithubPrRefQuerySchema, { chatId: 'chat-1', number: 42 })).toBe(true);
    expect(Value.Check(GithubPrRefQuerySchema, { chatId: 'chat-1', number: 0 })).toBe(false);
    expect(Value.Check(GithubPrRefQuerySchema, { number: 42 })).toBe(false);
  });

  it('validates the write bodies', () => {
    const body: GithubCreatePrBody = { chatId: 'chat-1', title: 'Add the panel' };
    expect(Value.Check(GithubCreatePrBodySchema, body)).toBe(true);
    expect(
      Value.Check(GithubCreatePrBodySchema, { ...body, body: 'why', draft: true, base: 'main' })
    ).toBe(true);
    expect(Value.Check(GithubCreatePrBodySchema, { ...body, title: '' })).toBe(false);
    expect(Value.Check(GithubCreatePrBodySchema, { ...body, base: '' })).toBe(false);

    expect(Value.Check(GithubPrActionBodySchema, { chatId: 'chat-1', number: 42 })).toBe(true);
    expect(Value.Check(GithubPrActionBodySchema, { chatId: 'chat-1', number: -1 })).toBe(false);
  });
});

describe('GitHub panel responses', () => {
  it('gives every response the same four not-connected states', () => {
    expect(Value.Check(GithubUnavailableStateSchema, { state: 'no-remote' })).toBe(true);
    expect(Value.Check(GithubUnavailableStateSchema, { state: 'ok' })).toBe(false);

    for (const schema of [
      GithubPrsResponseSchema,
      GithubIssuesResponseSchema,
      GithubInboxResponseSchema,
      GithubPrDetailResponseSchema,
      GithubPrChecksResponseSchema,
      GithubPrThreadsResponseSchema,
      GithubCreatePrResponseSchema,
      GithubPrActionResponseSchema,
    ]) {
      expectUnavailableStates(schema);
    }
  });

  it('carries a cached-at stamp on every read payload', () => {
    const prs = { state: 'ok', cachedAt: 1_756_119_600_000, repo, prs: [prSummary] };
    expect(Value.Check(GithubPrsResponseSchema, prs)).toBe(true);
    const { cachedAt: _dropped, ...withoutStamp } = prs;
    expect(Value.Check(GithubPrsResponseSchema, withoutStamp)).toBe(false);
    expect(Value.Check(GithubPrsResponseSchema, { ...prs, cachedAt: -1 })).toBe(false);

    expect(
      Value.Check(GithubIssuesResponseSchema, {
        state: 'ok',
        cachedAt: 1,
        repo,
        issues: [issue],
      })
    ).toBe(true);
    expect(
      Value.Check(GithubPrDetailResponseSchema, {
        state: 'ok',
        cachedAt: 1,
        repo,
        pr: prDetail,
      })
    ).toBe(true);
    expect(
      Value.Check(GithubPrChecksResponseSchema, {
        state: 'ok',
        cachedAt: 1,
        repo,
        summary: checks,
        checks: [checkRun],
      })
    ).toBe(true);
    expect(
      Value.Check(GithubPrThreadsResponseSchema, {
        state: 'ok',
        cachedAt: 1,
        repo,
        threads: [reviewThread],
      })
    ).toBe(true);
  });

  it('omits the repository from the cross-repo inbox', () => {
    expect(
      Value.Check(GithubInboxResponseSchema, { state: 'ok', cachedAt: 1, items: [inboxItem] })
    ).toBe(true);
    expect(Value.Check(GithubInboxResponseSchema, { state: 'ok', cachedAt: 1 })).toBe(false);
  });

  it('answers writes without a staleness stamp', () => {
    expect(Value.Check(GithubCreatePrResponseSchema, { state: 'ok', repo, pr: prSummary })).toBe(
      true
    );
    expect(Value.Check(GithubPrActionResponseSchema, { state: 'ok', pr: prSummary })).toBe(true);
    expect(Value.Check(GithubPrActionResponseSchema, { state: 'ok' })).toBe(false);
  });
});
