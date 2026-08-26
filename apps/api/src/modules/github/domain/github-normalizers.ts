/**
 * Where gh's output stops disagreeing with the contract.
 *
 * The shared schemas model one shape per concept; `gh` models several, and the
 * differences are not cosmetic — they are the kind that make a panel show the
 * wrong thing rather than crash:
 *
 *   - `gh search prs` spells pull request state *lowercase* ("open") while
 *     `gh pr list` and `gh pr view` spell it uppercase ("OPEN", "MERGED"). One
 *     casing reaches the client, so the inbox is upper-cased here.
 *   - `reviewDecision` arrives as `""` rather than null or absent, on a pull
 *     request that simply has no decision yet.
 *   - `author.is_bot` is the single snake_case key gh emits. It becomes `isBot`
 *     and the remaining actor fields are dropped.
 *   - `startedAt` / `completedAt` arrive as the zero timestamp
 *     `0001-01-01T00:00:00Z` for a check that has not started or finished. Those
 *     are omitted rather than shipped, because every date formatter downstream
 *     would render a year-1 date as a real one.
 *   - `statusCheckRollup` is a full per-check array on every row, reduced to
 *     four counters by `check-rollup.ts` before it can reach the wire.
 *
 * Every function here is pure and throws on a value gh has never emitted;
 * `readGhOutput` turns that into one command-labelled failure.
 */

import type {
  GithubActor,
  GithubCheckBucket,
  GithubCheckRun,
  GithubInboxItem,
  GithubIssueState,
  GithubIssueSummary,
  GithubLabel,
  GithubLatestReview,
  GithubMergeableState,
  GithubMergeStateStatus,
  GithubPrDetail,
  GithubPrState,
  GithubPrSummary,
  GithubReviewDecision,
  GithubReviewState,
  GithubReviewThread,
} from '@mangostudio/shared/github';
import { summarizeOptionalCheckRollup } from './check-rollup';
import type {
  GhActorOutput,
  GhCheckRunListOutput,
  GhIssueListOutput,
  GhPrDetailOutput,
  GhPrSummaryOutput,
  GhReviewThreadsOutput,
  GhSearchPrListOutput,
} from './gh-output';

/** gh's "this never happened" timestamp, which is not a date any user should see. */
const ZERO_TIMESTAMP = '0001-01-01T00:00:00Z';

const PR_STATES: readonly GithubPrState[] = ['OPEN', 'CLOSED', 'MERGED'];
const ISSUE_STATES: readonly GithubIssueState[] = ['OPEN', 'CLOSED'];
const REVIEW_DECISIONS: readonly GithubReviewDecision[] = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'REVIEW_REQUIRED',
];
const REVIEW_STATES: readonly GithubReviewState[] = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
];
const MERGE_STATE_STATUSES: readonly GithubMergeStateStatus[] = [
  'BEHIND',
  'BLOCKED',
  'CLEAN',
  'DIRTY',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN',
  'UNSTABLE',
];
const MERGEABLE_STATES: readonly GithubMergeableState[] = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'];
const CHECK_BUCKETS: readonly GithubCheckBucket[] = [
  'pass',
  'fail',
  'pending',
  'skipping',
  'cancel',
];

/**
 * Maps gh's actor onto the contract's, renaming its one snake_case key.
 *
 * @example
 * toActor({ login: 'dependabot', is_bot: true }); // { login: 'dependabot', isBot: true }
 */
export function toActor(actor: GhActorOutput | null | undefined): GithubActor | null {
  if (!actor) return null;
  return { login: actor.login, ...(actor.is_bot === undefined ? {} : { isBot: actor.is_bot }) };
}

/** Labels default to empty rather than absent: a row with none renders no chips. */
function toLabels(labels: readonly GithubLabel[] | undefined): GithubLabel[] {
  return (labels ?? []).map((label) => ({ name: label.name, color: label.color }));
}

/**
 * Normalizes gh's three spellings of "no review decision" into one.
 *
 * `""` is what gh actually emits — observed on a merged pull request — and an
 * absent key is what a `--json` list without the field produces. Both become
 * null, so the panel tests one thing.
 *
 * @example
 * toReviewDecision(''); // null
 */
export function toReviewDecision(value: string | undefined): GithubReviewDecision | null {
  if (!value) return null;
  return oneOf(REVIEW_DECISIONS, value);
}

/**
 * Upper-cases a pull request state, which is what makes the inbox agree with
 * every other list.
 *
 * @example
 * toPrState('open'); // 'OPEN'
 */
export function toPrState(value: string): GithubPrState {
  return required(oneOf(PR_STATES, value.toUpperCase()), `pull request state "${value}"`);
}

/** One `gh pr list` / `gh pr view` row as the contract's list row. */
export function toPrSummary(row: GhPrSummaryOutput): GithubPrSummary {
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    state: toPrState(row.state),
    isDraft: row.isDraft,
    headRefName: row.headRefName,
    baseRefName: row.baseRefName,
    updatedAt: row.updatedAt,
    author: toActor(row.author),
    labels: toLabels(row.labels),
    reviewDecision: toReviewDecision(row.reviewDecision),
    checks: summarizeOptionalCheckRollup(row.statusCheckRollup),
  };
}

/** `gh pr list` output as contract rows. */
export function toPrSummaries(rows: readonly GhPrSummaryOutput[]): GithubPrSummary[] {
  return rows.map(toPrSummary);
}

/** `gh pr view <n>` output as the detail drawer's shape. */
export function toPrDetail(row: GhPrDetailOutput): GithubPrDetail {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    url: row.url,
    reviewDecision: toReviewDecision(row.reviewDecision),
    mergeStateStatus: oneOf(MERGE_STATE_STATUSES, row.mergeStateStatus ?? '') ?? 'UNKNOWN',
    mergeable: oneOf(MERGEABLE_STATES, row.mergeable ?? '') ?? 'UNKNOWN',
    changedFiles: row.changedFiles,
    additions: row.additions,
    deletions: row.deletions,
    latestReviews: (row.latestReviews ?? []).map(toLatestReview),
    labels: toLabels(row.labels),
  };
}

/** `gh pr checks <n>` rows, minus the timestamps gh spells as year 1. */
export function toCheckRuns(rows: GhCheckRunListOutput): GithubCheckRun[] {
  return rows.map((row) => ({
    name: row.name ?? '',
    bucket: required(oneOf(CHECK_BUCKETS, row.bucket), `check bucket "${row.bucket}"`),
    state: row.state,
    link: row.link ?? '',
    workflow: row.workflow ?? '',
    description: row.description ?? '',
    ...timestamp('startedAt', row.startedAt),
    ...timestamp('completedAt', row.completedAt),
  }));
}

/** `gh issue list` rows as contract rows. */
export function toIssueSummaries(rows: GhIssueListOutput): GithubIssueSummary[] {
  return rows.map((row) => ({
    number: row.number,
    title: row.title,
    url: row.url,
    state: required(oneOf(ISSUE_STATES, row.state.toUpperCase()), `issue state "${row.state}"`),
    updatedAt: row.updatedAt,
    author: toActor(row.author),
    labels: toLabels(row.labels),
    assignees: row.assignees?.flatMap((actor) => toActor(actor) ?? []) ?? [],
  }));
}

/** `gh search prs` rows, whose lowercase state is the reason this exists. */
export function toInboxItems(rows: GhSearchPrListOutput): GithubInboxItem[] {
  return rows.map((row) => ({
    number: row.number,
    title: row.title,
    url: row.url,
    state: toPrState(row.state),
    isDraft: row.isDraft,
    updatedAt: row.updatedAt,
    author: toActor(row.author),
    labels: toLabels(row.labels),
    repository: { nameWithOwner: row.repository.nameWithOwner },
  }));
}

/**
 * The pinned GraphQL document's response as the contract's thread list.
 *
 * `truncated` is true when the document's fixed `first: 50` / `first: 20`
 * pages cut something off — a thread beyond the first 50, or a comment beyond
 * a thread's first 20 — which `totalCount` on each connection says without
 * needing to paginate either one. Silently returning a partial list here would
 * hand an agent an "unresolved review comments" task that reads as complete.
 */
export function toReviewThreads(payload: GhReviewThreadsOutput): {
  threads: GithubReviewThread[];
  truncated: boolean;
} {
  const reviewThreads = payload.data.repository.pullRequest.reviewThreads;
  const threads = reviewThreads.nodes.map((thread) => ({
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path,
    // Null on an outdated thread whose anchor left the diff. Carried through
    // rather than defaulted, because zero is a line number and null is not.
    line: thread.line === null || thread.line < 1 ? null : thread.line,
    comments: thread.comments.nodes.map((comment) => ({
      author: toActor(comment.author),
      body: comment.body,
    })),
  }));
  const truncated =
    reviewThreads.totalCount > reviewThreads.nodes.length ||
    reviewThreads.nodes.some((thread) => thread.comments.totalCount > thread.comments.nodes.length);
  return { threads, truncated };
}

function toLatestReview(review: {
  author?: GhActorOutput | null;
  state: string;
  body?: string;
  submittedAt?: string | null;
}): GithubLatestReview {
  return {
    author: toActor(review.author),
    state: required(oneOf(REVIEW_STATES, review.state), `review state "${review.state}"`),
    body: review.body ?? '',
    ...timestamp('submittedAt', review.submittedAt),
  };
}

/** Omits the key entirely when gh has nothing real to say about the time. */
function timestamp<K extends string>(
  key: K,
  value: string | null | undefined
): Record<K, string> | Record<string, never> {
  if (!value || value === ZERO_TIMESTAMP) return {};
  return { [key]: value } as Record<K, string>;
}

function oneOf<T extends string>(allowed: readonly T[], value: string): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

function required<T>(value: T | null, subject: string): T {
  if (value === null) throw new TypeError(`GitHub CLI reported an unknown ${subject}.`);
  return value;
}
