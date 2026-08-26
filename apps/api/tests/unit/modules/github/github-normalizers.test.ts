import { describe, expect, it } from 'bun:test';
import {
  GhCheckRunListSchema,
  GhIssueListSchema,
  GhPrDetailOutputSchema,
  GhPrSummaryListSchema,
  GhReviewThreadsOutputSchema,
  GhSearchPrListSchema,
  GithubOutputError,
  readGhOutput,
} from '../../../../src/modules/github/domain/gh-output';
import {
  toActor,
  toCheckRuns,
  toInboxItems,
  toIssueSummaries,
  toPrDetail,
  toPrState,
  toPrSummaries,
  toReviewDecision,
  toReviewThreads,
} from '../../../../src/modules/github/domain/github-normalizers';

const prListRow = {
  number: 7,
  title: 'Add the panel',
  url: 'https://github.example/mango/mangostudio/pull/7',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/panel',
  baseRefName: 'main',
  updatedAt: '2026-08-20T10:00:00Z',
  author: { id: 'MDQ6', is_bot: false, login: 'octocat', name: 'Mona' },
  labels: [{ id: 'L1', name: 'area:api', description: '', color: 'c5def5' }],
  reviewDecision: '',
  statusCheckRollup: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'coderabbit', state: 'PENDING' },
  ],
};

describe('gh output normalizers', () => {
  it('renames gh’s one snake_case key and drops the rest of the actor', () => {
    expect(toActor({ login: 'dependabot', is_bot: true })).toEqual({
      login: 'dependabot',
      isBot: true,
    });
    // A deleted account is GitHub's "ghost" user, which gh reports as null.
    expect(toActor(null)).toBeNull();
    expect(toActor(undefined)).toBeNull();
  });

  it('normalizes gh’s empty-string review decision to null', () => {
    expect(toReviewDecision('')).toBeNull();
    expect(toReviewDecision(undefined)).toBeNull();
    expect(toReviewDecision('APPROVED')).toBe('APPROVED');
    expect(toReviewDecision('CHANGES_REQUESTED')).toBe('CHANGES_REQUESTED');
  });

  it('upper-cases the state gh search prs spells in lower case', () => {
    expect(toPrState('open')).toBe('OPEN');
    expect(toPrState('OPEN')).toBe('OPEN');
    expect(toPrState('merged')).toBe('MERGED');
  });

  it('reduces the rollup rather than letting it reach the client', () => {
    const [row] = toPrSummaries([prListRow]);
    expect(row).toEqual({
      number: 7,
      title: 'Add the panel',
      url: 'https://github.example/mango/mangostudio/pull/7',
      state: 'OPEN',
      isDraft: false,
      headRefName: 'feat/panel',
      baseRefName: 'main',
      updatedAt: '2026-08-20T10:00:00Z',
      author: { login: 'octocat', isBot: false },
      labels: [{ name: 'area:api', color: 'c5def5' }],
      reviewDecision: null,
      checks: { passed: 1, failed: 0, pending: 1, total: 2 },
    });
    expect(JSON.stringify(row)).not.toContain('statusCheckRollup');
  });

  it('reports a pull request with no CI as null checks, not zero checks', () => {
    const [withoutRollup] = toPrSummaries([{ ...prListRow, statusCheckRollup: null }]);
    expect(withoutRollup?.checks).toBeNull();
  });

  it('drops gh’s year-1 timestamps instead of shipping them as dates', () => {
    const [row] = toCheckRuns([
      {
        name: 'build',
        bucket: 'pending',
        state: 'IN_PROGRESS',
        link: 'https://ci.example/1',
        workflow: 'CI',
        description: '',
        startedAt: '2026-08-20T10:00:00Z',
        completedAt: '0001-01-01T00:00:00Z',
      },
    ]);
    expect(row).toEqual({
      name: 'build',
      bucket: 'pending',
      state: 'IN_PROGRESS',
      link: 'https://ci.example/1',
      workflow: 'CI',
      description: '',
      startedAt: '2026-08-20T10:00:00Z',
    });
    expect(row).not.toHaveProperty('completedAt');
  });

  it('collapses an unknown merge state onto the enum’s own escape hatch', () => {
    const detail = toPrDetail({
      number: 7,
      title: 'Add the panel',
      body: 'why',
      url: 'https://github.example/mango/mangostudio/pull/7',
      isDraft: false,
      reviewDecision: '',
      mergeStateStatus: 'SOMETHING_NEW',
      mergeable: 'SOMETHING_NEW',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
      latestReviews: [
        { author: null, state: 'APPROVED', body: '', submittedAt: '2026-08-20T10:00:00Z' },
      ],
      labels: [],
    });
    expect(detail.mergeStateStatus).toBe('UNKNOWN');
    expect(detail.mergeable).toBe('UNKNOWN');
    expect(detail.reviewDecision).toBeNull();
    expect(detail.latestReviews[0]?.author).toBeNull();
  });

  /**
   * `mergeStateStatus` is computed asynchronously and requires push access, so
   * GitHub answers `BLOCKED` or `UNKNOWN` for a draft as readily as `DRAFT` —
   * `gh pr view 940 --json isDraft,mergeStateStatus` on this repository returns
   * `{"isDraft":true,"mergeStateStatus":"BLOCKED"}`. Draftness therefore has to
   * come from `isDraft`, or the panel hides "mark ready for review" on exactly
   * the pull requests that need it.
   */
  it('carries draftness from isDraft rather than from the merge state', () => {
    const draft = toPrDetail({
      number: 940,
      title: 'Add the panel',
      body: 'why',
      url: 'https://github.example/mango/mangostudio/pull/940',
      isDraft: true,
      reviewDecision: '',
      mergeStateStatus: 'BLOCKED',
      mergeable: 'MERGEABLE',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
      latestReviews: [],
      labels: [],
    });
    expect(draft.isDraft).toBe(true);
    expect(draft.mergeStateStatus).toBe('BLOCKED');
  });

  it('upper-cases inbox rows so one vocabulary reaches the panel', () => {
    const [item] = toInboxItems([
      {
        number: 12,
        title: 'Review me',
        url: 'https://github.example/other/repo/pull/12',
        state: 'open',
        isDraft: false,
        updatedAt: '2026-08-20T10:00:00Z',
        author: { is_bot: false, login: 'octocat' },
        labels: [],
        repository: { nameWithOwner: 'other/repo' },
      },
    ]);
    expect(item?.state).toBe('OPEN');
    expect(item?.repository).toEqual({ nameWithOwner: 'other/repo' });
  });

  it('keeps issue rows and their assignees', () => {
    const [issue] = toIssueSummaries([
      {
        number: 3,
        title: 'Broken',
        url: 'https://github.example/mango/mangostudio/issues/3',
        state: 'OPEN',
        updatedAt: '2026-08-20T10:00:00Z',
        author: { is_bot: false, login: 'octocat' },
        labels: [{ name: 'type:bug', color: 'BFDADC' }],
        assignees: [{ is_bot: false, login: 'hubot' }],
      },
    ]);
    expect(issue?.assignees).toEqual([{ login: 'hubot', isBot: false }]);
    expect(issue?.labels).toEqual([{ name: 'type:bug', color: 'BFDADC' }]);
  });

  it('carries a null line on an outdated review thread', () => {
    const result = toReviewThreads({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              totalCount: 1,
              nodes: [
                {
                  isResolved: false,
                  isOutdated: true,
                  path: 'apps/api/src/x.ts',
                  line: null,
                  comments: { totalCount: 1, nodes: [{ author: null, body: 'gone' }] },
                },
              ],
            },
          },
        },
      },
    });
    expect(result).toEqual({
      threads: [
        {
          isResolved: false,
          isOutdated: true,
          path: 'apps/api/src/x.ts',
          line: null,
          comments: [{ author: null, body: 'gone' }],
        },
      ],
      truncated: false,
    });
  });

  /**
   * `totalCount` on either connection outrunning what the fixed page actually
   * returned is the only signal the pinned document gives that a thread or a
   * comment was cut off, since it never paginates.
   */
  it('reports truncation when totalCount outruns either fixed page', () => {
    const threadTruncated = toReviewThreads({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { totalCount: 51, nodes: [] },
          },
        },
      },
    });
    expect(threadTruncated.truncated).toBe(true);

    const commentTruncated = toReviewThreads({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              totalCount: 1,
              nodes: [
                {
                  isResolved: false,
                  isOutdated: false,
                  path: 'apps/api/src/x.ts',
                  line: 10,
                  comments: { totalCount: 21, nodes: [{ author: null, body: 'first' }] },
                },
              ],
            },
          },
        },
      },
    });
    expect(commentTruncated.truncated).toBe(true);
  });
});

describe('readGhOutput', () => {
  it('labels malformed JSON with the command that produced it', () => {
    const error = (() => {
      try {
        readGhOutput('pr.list', '{not-json', GhPrSummaryListSchema, toPrSummaries);
        return null;
      } catch (cause) {
        return cause;
      }
    })();

    expect(error).toBeInstanceOf(GithubOutputError);
    expect(error).toMatchObject({ command: 'pr.list', code: 'GH_OUTPUT_INVALID' });
  });

  it('fails the same way when a normalizer meets a value gh has never emitted', () => {
    // Without this, a fourth pull request state would either throw a raw
    // TypeError or be silently reported as some other state.
    expect(() =>
      readGhOutput(
        'pr.list',
        JSON.stringify([{ ...prListRow, state: 'ARCHIVED' }]),
        GhPrSummaryListSchema,
        toPrSummaries
      )
    ).toThrow(GithubOutputError);
  });

  it('accepts the extra keys gh adds between releases', () => {
    const rows = readGhOutput(
      'pr.list',
      JSON.stringify([{ ...prListRow, somethingNew: true }]),
      GhPrSummaryListSchema,
      toPrSummaries
    );
    expect(rows).toHaveLength(1);
  });

  it('reads every other command’s real output shape', () => {
    expect(readGhOutput('pr.checks', '[]', GhCheckRunListSchema, toCheckRuns)).toEqual([]);
    expect(readGhOutput('issue.list', '[]', GhIssueListSchema, toIssueSummaries)).toEqual([]);
    expect(readGhOutput('search.prs', '[]', GhSearchPrListSchema, toInboxItems)).toEqual([]);
    expect(() =>
      readGhOutput('pr.view', '{"number":0}', GhPrDetailOutputSchema, toPrDetail)
    ).toThrow(GithubOutputError);
    expect(() =>
      readGhOutput('pr.review-threads', '{"data":{}}', GhReviewThreadsOutputSchema, toReviewThreads)
    ).toThrow(GithubOutputError);
  });
});
