import Type, { type Static } from 'typebox';

/**
 * The four ways a GitHub read can come back with nothing to show, declared once
 * and spread into every response union below.
 *
 * They are shared rather than repeated because the panel must have exactly one
 * "not connected" renderer. Endpoint-local copies drift: the first time the PR
 * list grows a fifth state the issue list does not have, a user who is simply
 * logged out gets two different explanations depending on which tab is open.
 *
 * Reusing this union is also why the GitHub panel adds no `ERROR_CODES`. A
 * checkout with no GitHub remote is not an error — it is a successful read of a
 * repository that has nothing to say — so it is a 200 carrying a state, and
 * `ApiErrorResponse` stays reserved for calls that actually failed.
 *
 * There is deliberately no `unsupported-environment` member. `gh` follows the
 * chat to whatever machine the runtime is on, so a host without the CLI is
 * `gh-not-installed` read off that runtime's manifest capability. A second way
 * to spell one state would give the panel two branches obliged to render
 * identically, and the day they stop matching is the day nobody notices.
 */
const GITHUB_UNAVAILABLE_MEMBERS = [
  Type.Object({ state: Type.Literal('gh-not-installed') }),
  Type.Object({ state: Type.Literal('not-authenticated') }),
  Type.Object({ state: Type.Literal('no-remote') }),
  Type.Object({ state: Type.Literal('not-a-github-remote') }),
] as const;

/**
 * The four non-ok states on their own, for the panel's shared empty-state view.
 *
 * Usage:
 *   if (response.state !== 'ok') return <GithubNotConnected state={response.state} />;
 */
export const GithubUnavailableStateSchema = Type.Union([...GITHUB_UNAVAILABLE_MEMBERS]);

/**
 * Epoch milliseconds at which the hub read this payload out of `gh`.
 *
 * The API caches GitHub reads for roughly a minute, so every `ok` payload says
 * when it was taken and the panel renders staleness ("updated 40s ago") instead
 * of presenting a cached list as live. Kept private: it is a field on responses,
 * never a shape a caller constructs on its own.
 */
const CachedAtSchema = Type.Integer({ minimum: 0 });

export const GithubPrStateSchema = Type.Union([
  Type.Literal('OPEN'),
  Type.Literal('CLOSED'),
  Type.Literal('MERGED'),
]);

export const GithubPrSchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  state: GithubPrStateSchema,
  isDraft: Type.Boolean(),
  url: Type.String(),
  headRefName: Type.String(),
  baseRefName: Type.String(),
});

export const GithubRepoSchema = Type.Object({
  nameWithOwner: Type.String(),
  defaultBranch: Type.String(),
  url: Type.String(),
});

export const GithubContextSchema = Type.Union([
  ...GITHUB_UNAVAILABLE_MEMBERS,
  Type.Object({
    state: Type.Literal('ok'),
    repo: GithubRepoSchema,
    pr: Type.Union([GithubPrSchema, Type.Null()]),
  }),
]);

export const GithubContextQuerySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
});

/**
 * Just enough of a GitHub actor to render a row.
 *
 * `gh pr list` returns `{id, is_bot, login, name}` and `gh search prs` returns
 * `{id, is_bot, login, type, url}` — `is_bot` being the single snake_case key in
 * an otherwise camelCase payload. The API boundary renames it to `isBot` and
 * drops the rest, because contracts in this repo are camelCase and one
 * snake_case field would be the only one in the codebase.
 *
 * `isBot` is optional rather than required: the two CLI commands agree on it,
 * but the pinned GraphQL document behind review threads does not select it, and
 * a thread comment's author is the same shape as a PR's.
 *
 * Usage:
 *   const label = author.isBot ? `${author.login} (bot)` : author.login;
 */
export const GithubActorSchema = Type.Object({
  login: Type.String(),
  isBot: Type.Optional(Type.Boolean()),
});

/** An author is null on rows whose account was deleted — GitHub's "ghost" user. */
const NullableActorSchema = Type.Union([GithubActorSchema, Type.Null()]);

/**
 * A label chip: the two fields a chip needs, out of gh's
 * `{id, name, description, color}`.
 *
 * `color` is a bare six-digit hex with no leading `#`, in inconsistent case
 * ("c5def5", "BFDADC", "0052CC"). The panel has to normalize it before it
 * reaches a style attribute — interpolating it raw produces `color: c5def5`,
 * which is not a color and fails silently rather than loudly.
 */
export const GithubLabelSchema = Type.Object({
  name: Type.String(),
  color: Type.String(),
});

/**
 * gh's three review verdicts.
 *
 * "No decision yet" is deliberately not a member. gh always emits the key and
 * spells the absent case as `""` (observed on a merged PR), which the API
 * boundary normalizes to `null`. Fields carrying a decision are therefore
 * `GithubReviewDecision | null` and *required* — never optional — so there is
 * one way to say "none" instead of three (`""`, `null`, absent) that a panel
 * would have to test for separately.
 */
export const GithubReviewDecisionSchema = Type.Union([
  Type.Literal('APPROVED'),
  Type.Literal('CHANGES_REQUESTED'),
  Type.Literal('REVIEW_REQUIRED'),
]);

const NullableReviewDecisionSchema = Type.Union([GithubReviewDecisionSchema, Type.Null()]);

/**
 * A server-side reduction of gh's `statusCheckRollup` to four counters.
 *
 * `gh pr list --json statusCheckRollup` returns the *full per-check array on
 * every row* — dozens of objects per PR, multiplied by the page size. That array
 * must never reach the client: it is by far the largest thing this panel could
 * ship, and the list view renders nothing from it but the counts.
 *
 * The reducer that produces this shape has to handle two GraphQL variants, both
 * of which occur against this repository, or it silently undercounts:
 *   - `{__typename: 'CheckRun', name, status, conclusion, workflowName, ...}` —
 *     pending while `status !== 'COMPLETED'`, otherwise `conclusion` is
 *     SUCCESS / FAILURE / SKIPPED.
 *   - `{__typename: 'StatusContext', context, state, targetUrl, ...}` — no
 *     `conclusion` and no `name` at all; `state` is one of SUCCESS, FAILURE,
 *     PENDING, ERROR, EXPECTED. Third-party bots (CodeRabbit and friends) report
 *     through this variant, so a reducer that only knows `CheckRun` reports a
 *     green PR as having no checks.
 *
 * `total` is carried rather than derived because skipped, neutral, and cancelled
 * checks belong to none of the three buckets: `passed + failed + pending` is
 * legitimately less than `total`.
 */
export const GithubCheckSummarySchema = Type.Object({
  passed: Type.Integer({ minimum: 0 }),
  failed: Type.Integer({ minimum: 0 }),
  pending: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
});

/** gh's own presentation grouping for a check row; the panel colours by member. */
export const GithubCheckBucketSchema = Type.Union([
  Type.Literal('pass'),
  Type.Literal('fail'),
  Type.Literal('pending'),
  Type.Literal('skipping'),
  Type.Literal('cancel'),
]);

/**
 * One row of
 * `gh pr checks <n> --json bucket,name,state,link,workflow,description,startedAt,completedAt`.
 *
 * `bucket` is closed because it is gh's own five-way grouping and the panel
 * needs a colour per member. `state` is deliberately left an open string: it is
 * the provider's raw verdict (SUCCESS, SKIPPED, NEUTRAL, ...), gh does not
 * document the full set, and a closed union over a vocabulary we do not own
 * turns the arrival of a new CI provider into a 500 on a read-only panel.
 *
 * `description` is a plain string, not optional: empty is the normal case for a
 * check that reports no summary line, and modelling that as "missing" would make
 * the panel test for two things that mean the same.
 *
 * `startedAt` and `completedAt` are optional because gh emits the zero timestamp
 * `0001-01-01T00:00:00Z` for checks that have not started or finished. The
 * boundary drops those rather than shipping a year-1 date that every date
 * formatter downstream would render as real.
 */
export const GithubCheckRunSchema = Type.Object({
  name: Type.String(),
  bucket: GithubCheckBucketSchema,
  state: Type.String(),
  link: Type.String(),
  workflow: Type.String(),
  description: Type.String(),
  startedAt: Type.Optional(Type.String()),
  completedAt: Type.Optional(Type.String()),
});

/**
 * A repo-scoped pull request row, from `gh pr list --json
 * number,title,url,state,isDraft,headRefName,baseRefName,updatedAt,author,labels,reviewDecision,statusCheckRollup`.
 *
 * Richer than `GithubPrSchema`, which stays as-is because the hub already serves
 * it as the single "PR for this branch" in `GithubContext`; this is the list row.
 *
 * `checks` is null when the PR has no CI at all, which is a different thing from
 * a summary whose counters are zero — that means the rollup came back empty for
 * a PR that does run checks, and the panel shows "waiting" rather than nothing.
 */
export const GithubPrSummarySchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  url: Type.String(),
  state: GithubPrStateSchema,
  isDraft: Type.Boolean(),
  headRefName: Type.String(),
  baseRefName: Type.String(),
  updatedAt: Type.String(),
  author: NullableActorSchema,
  labels: Type.Array(GithubLabelSchema),
  reviewDecision: NullableReviewDecisionSchema,
  checks: Type.Union([GithubCheckSummarySchema, Type.Null()]),
});

/** GitHub's `MergeStateStatus`; `UNKNOWN` is the enum's own escape hatch. */
export const GithubMergeStateStatusSchema = Type.Union([
  Type.Literal('BEHIND'),
  Type.Literal('BLOCKED'),
  Type.Literal('CLEAN'),
  Type.Literal('DIRTY'),
  Type.Literal('DRAFT'),
  Type.Literal('HAS_HOOKS'),
  Type.Literal('UNKNOWN'),
  Type.Literal('UNSTABLE'),
]);

/** GitHub's `MergeableState`; `UNKNOWN` means the mergeability job is still running. */
export const GithubMergeableStateSchema = Type.Union([
  Type.Literal('MERGEABLE'),
  Type.Literal('CONFLICTING'),
  Type.Literal('UNKNOWN'),
]);

/** GitHub's `PullRequestReviewState`, the per-review verdict behind a decision. */
export const GithubReviewStateSchema = Type.Union([
  Type.Literal('APPROVED'),
  Type.Literal('CHANGES_REQUESTED'),
  Type.Literal('COMMENTED'),
  Type.Literal('DISMISSED'),
  Type.Literal('PENDING'),
]);

/** One entry of gh's `latestReviews`: the newest verdict per reviewer. */
export const GithubLatestReviewSchema = Type.Object({
  author: NullableActorSchema,
  state: GithubReviewStateSchema,
  body: Type.String(),
  submittedAt: Type.Optional(Type.String()),
});

/**
 * The detail view, from `gh pr view <n> --json
 * number,title,body,reviewDecision,mergeStateStatus,mergeable,changedFiles,additions,deletions,latestReviews,labels,url`.
 *
 * `mergeStateStatus` and `mergeable` are closed unions where `state` on a check
 * run is not, because these two are documented GraphQL enums that GitHub owns
 * and versions, and both already carry `UNKNOWN` as the member a value we have
 * not seen collapses into.
 *
 * Inline review conversations are absent on purpose — see `GithubReviewThread`.
 */
export const GithubPrDetailSchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  body: Type.String(),
  url: Type.String(),
  /**
   * Carried in its own right rather than read off `mergeStateStatus`. That field
   * is computed asynchronously and needs push access, so a draft pull request
   * reports `BLOCKED` or `UNKNOWN` there as often as it reports `DRAFT` — and a
   * "mark ready" affordance derived from it disappears on real drafts.
   */
  isDraft: Type.Boolean(),
  reviewDecision: NullableReviewDecisionSchema,
  mergeStateStatus: GithubMergeStateStatusSchema,
  mergeable: GithubMergeableStateSchema,
  changedFiles: Type.Integer({ minimum: 0 }),
  additions: Type.Integer({ minimum: 0 }),
  deletions: Type.Integer({ minimum: 0 }),
  latestReviews: Type.Array(GithubLatestReviewSchema),
  labels: Type.Array(GithubLabelSchema),
});

/** One comment inside an inline review conversation. */
export const GithubReviewThreadCommentSchema = Type.Object({
  author: NullableActorSchema,
  body: Type.String(),
});

/**
 * One inline review conversation, from a pinned GraphQL document.
 *
 * `gh pr view --json reviews,comments` cannot produce this shape, and that is
 * the whole reason a GraphQL document exists for this panel: `reviews` carries
 * review *summaries* and `comments` carries issue-level comments, neither with a
 * file/line anchor and neither with resolved state. "Which threads are still
 * unresolved" — the single question the review-comments action exists to answer
 * — is only reachable through GraphQL's `reviewThreads` connection.
 *
 * `line` is null on an outdated thread whose anchor no longer exists in the
 * current diff; `isOutdated` says why, so the panel can still show the text.
 */
export const GithubReviewThreadSchema = Type.Object({
  isResolved: Type.Boolean(),
  isOutdated: Type.Boolean(),
  path: Type.String(),
  line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  comments: Type.Array(GithubReviewThreadCommentSchema),
});

/** An issue is open or closed; it has no third state the way a PR has `MERGED`. */
export const GithubIssueStateSchema = Type.Union([Type.Literal('OPEN'), Type.Literal('CLOSED')]);

/**
 * An issue row, from
 * `gh issue list --json number,title,state,labels,author,updatedAt,url,assignees`.
 */
export const GithubIssueSummarySchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  url: Type.String(),
  state: GithubIssueStateSchema,
  updatedAt: Type.String(),
  author: NullableActorSchema,
  labels: Type.Array(GithubLabelSchema),
  assignees: Type.Array(GithubActorSchema),
});

/**
 * A cross-repo "waiting on you" row, from `gh search prs --review-requested=@me
 * --state=open --json number,title,repository,updatedAt,author,isDraft,labels,state,url`.
 *
 * Deliberately *thinner* than `GithubPrSummary`, and it must stay that way. The
 * search endpoint's `--json` field list has no `reviewDecision` and no
 * `statusCheckRollup` — checked against the full list, not assumed — so an inbox
 * row cannot carry a review verdict or check counters however the query is
 * written. Do not "fix" the asymmetry by adding those fields: the only way to
 * fill them is one extra `gh pr view` per row, which turns a single search into
 * N API calls for a header section that shows a title and a repository name.
 *
 * `state` reuses `GithubPrStateSchema` even though the wire values disagree:
 * `gh search prs` returns state *lowercase* ("open") while `gh pr list` and
 * `gh pr view` return it uppercase ("OPEN", "MERGED"). The API boundary
 * upper-cases the search value so the panel has one vocabulary and one set of
 * translations. The contract models one casing on purpose — two would push the
 * normalization into every consumer instead of the one place that reads gh.
 *
 * `repository` is reduced to `nameWithOwner`: a search row carries
 * `{name, nameWithOwner}` and no repository URL, so "open in browser" uses the
 * row's own top-level `url`, which points at the PR anyway.
 */
export const GithubInboxItemSchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  url: Type.String(),
  state: GithubPrStateSchema,
  isDraft: Type.Boolean(),
  updatedAt: Type.String(),
  author: NullableActorSchema,
  labels: Type.Array(GithubLabelSchema),
  repository: Type.Object({ nameWithOwner: Type.String() }),
});

/**
 * Closed literal unions, and that is precisely the point: these values choose
 * which flags a `gh` invocation gets. `mine` becomes `--author=@me`,
 * `review-requested` becomes `--search=review-requested:@me`. Were the field a
 * `Type.String()`, a query parameter would reach argv verbatim on a CLI that can
 * push branches, merge pull requests, and delete repositories.
 *
 * `all` is the only member that is not a view somebody browses. The other three
 * all resolve to `--state=open`, so none of them can answer "is this branch's
 * pull request merged" — and that is precisely the question the branch list
 * asks before offering to delete a branch. `all` maps to `--state=all` and
 * exists for that annotation: a merged branch is visibly safe to delete only if
 * closed and merged pull requests are reachable at all.
 */
export const GithubPrFilterSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('mine'),
  Type.Literal('review-requested'),
  Type.Literal('all'),
]);

/** Closed for the same reason as `GithubPrFilterSchema`: it selects gh flags. */
export const GithubIssueFilterSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('assigned'),
  Type.Literal('mine'),
]);

/**
 * Page size for every GitHub list.
 *
 * Capped at 30 because each page is a live round trip through `gh` to GitHub's
 * API on whatever machine the runtime is on, and a side panel that shows ten
 * rows has no use for a hundred. The floor of 1 keeps `limit=0` — which `gh`
 * would read as "no limit" — from being expressible at all.
 */
const GithubListLimitSchema = Type.Integer({ minimum: 1, maximum: 30 });

/** Page size the API applies when a list query omits `limit`. */
export const GITHUB_LIST_LIMIT_DEFAULT = 20;

/**
 * `refresh` bypasses the API's ~60s read-through cache for this one call. The
 * panel's own 60s `staleTime` already skips a refetch that would just hit
 * that cache, so a request carrying it is always the user's own refresh
 * button — the one case where "the cached answer is still young" is the
 * wrong tradeoff.
 */
const GithubRefreshSchema = Type.Optional(Type.Boolean());

export const GithubPrsQuerySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  filter: Type.Optional(GithubPrFilterSchema),
  limit: Type.Optional(GithubListLimitSchema),
  refresh: GithubRefreshSchema,
});

export const GithubIssuesQuerySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  filter: Type.Optional(GithubIssueFilterSchema),
  limit: Type.Optional(GithubListLimitSchema),
  refresh: GithubRefreshSchema,
});

/**
 * The inbox is the one GitHub read that is not chat-scoped: "waiting on you"
 * spans every repository the user can see, so there is no chat whose workdir
 * would pick a repository, and no `chatId`.
 *
 * `environmentId` picks which machine's `gh` answers — the CLI follows the chat,
 * so credentials differ per host. Absent means the hub's own environment.
 */
export const GithubInboxQuerySchema = Type.Object({
  environmentId: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(GithubListLimitSchema),
  refresh: GithubRefreshSchema,
});

/**
 * One reference shape for every per-PR read. Detail, checks, and review threads
 * each need exactly "which chat, and which number"; three identical schemas
 * would be three places to forget the `minimum: 1` that keeps `gh pr view 0`
 * from ever being attempted.
 *
 * The number travels in the query rather than the path, so all three reads share
 * one schema and one route shape.
 *
 * Usage:
 *   .get('/github/pr/checks', handler, { query: GithubPrRefQuerySchema })
 */
export const GithubPrRefQuerySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  number: Type.Integer({ minimum: 1 }),
});

export const GithubCreatePrBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  body: Type.Optional(Type.String({ maxLength: 60_000 })),
  draft: Type.Optional(Type.Boolean()),
  base: Type.Optional(Type.String({ minLength: 1 })),
});

/**
 * `gh pr ready` and `gh pr checkout` need the same two things and nothing else.
 * One schema rather than two identical ones, because identical schemas drift:
 * the tightening that lands on one is the tightening the other misses.
 */
export const GithubPrActionBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  number: Type.Integer({ minimum: 1 }),
});

export const GithubPrsResponseSchema = Type.Union([
  ...GITHUB_UNAVAILABLE_MEMBERS,
  Type.Object({
    state: Type.Literal('ok'),
    cachedAt: CachedAtSchema,
    repo: GithubRepoSchema,
    prs: Type.Array(GithubPrSummarySchema),
  }),
]);

export const GithubIssuesResponseSchema = Type.Union([
  ...GITHUB_UNAVAILABLE_MEMBERS,
  Type.Object({
    state: Type.Literal('ok'),
    cachedAt: CachedAtSchema,
    repo: GithubRepoSchema,
    issues: Type.Array(GithubIssueSummarySchema),
  }),
]);

/**
 * The inbox carries no `repo`: its rows come from a cross-repo search, so there
 * is no one repository the response is about.
 *
 * It still carries the same four unavailable states, and `no-remote` /
 * `not-a-github-remote` are simply never emitted for it — a search needs an
 * authenticated CLI, not a checkout. Keeping the union uniform costs two states
 * this endpoint will not use and buys the panel one renderer for all of them.
 */
export const GithubInboxResponseSchema = Type.Union([
  ...GITHUB_UNAVAILABLE_MEMBERS,
  Type.Object({
    state: Type.Literal('ok'),
    cachedAt: CachedAtSchema,
    items: Type.Array(GithubInboxItemSchema),
  }),
]);

export const GithubPrDetailResponseSchema = Type.Union([
  ...GITHUB_UNAVAILABLE_MEMBERS,
  Type.Object({
    state: Type.Literal('ok'),
    cachedAt: CachedAtSchema,
    repo: GithubRepoSchema,
    pr: GithubPrDetailSchema,
  }),
]);

/**
 * Checks come back as both the rows and their reduction. The summary is not
 * derived on the client because the detail view and the list row must agree on
 * the counts, and one reducer that runs beside `gh` is how they do.
 */
export const GithubPrChecksResponseSchema = Type.Union([
  ...GITHUB_UNAVAILABLE_MEMBERS,
  Type.Object({
    state: Type.Literal('ok'),
    cachedAt: CachedAtSchema,
    repo: GithubRepoSchema,
    summary: GithubCheckSummarySchema,
    checks: Type.Array(GithubCheckRunSchema),
  }),
]);

export const GithubPrThreadsResponseSchema = Type.Union([
  ...GITHUB_UNAVAILABLE_MEMBERS,
  Type.Object({
    state: Type.Literal('ok'),
    cachedAt: CachedAtSchema,
    repo: GithubRepoSchema,
    threads: Type.Array(GithubReviewThreadSchema),
    /**
     * True when the pinned document's fixed pages cut something off: a
     * thread beyond the first 50, or a comment beyond a thread's first 20.
     * `threads` is never silently incomplete without this saying so.
     */
    truncated: Type.Boolean(),
  }),
]);

/**
 * Write results reuse the four unavailable states — a user can lose GitHub
 * between opening the panel and pressing a button — but carry no `cachedAt`.
 * A write's result is what just happened, not a cache read, and a staleness
 * label on it would always read "now" while meaning nothing.
 */
export const GithubCreatePrResponseSchema = Type.Union([
  ...GITHUB_UNAVAILABLE_MEMBERS,
  Type.Object({
    state: Type.Literal('ok'),
    repo: GithubRepoSchema,
    pr: GithubPrSummarySchema,
  }),
]);

/**
 * Shared by `pr ready` and `pr checkout`: both answer with the pull request as
 * it now stands. Checkout's branch name is already `pr.headRefName`, so there is
 * no second field that could disagree with it.
 */
export const GithubPrActionResponseSchema = Type.Union([
  ...GITHUB_UNAVAILABLE_MEMBERS,
  Type.Object({
    state: Type.Literal('ok'),
    pr: GithubPrSummarySchema,
  }),
]);

export type GithubPrState = Static<typeof GithubPrStateSchema>;
export type GithubPr = Static<typeof GithubPrSchema>;
export type GithubRepo = Static<typeof GithubRepoSchema>;
export type GithubContext = Static<typeof GithubContextSchema>;
export type GithubContextQuery = Static<typeof GithubContextQuerySchema>;
export type GithubUnavailableState = Static<typeof GithubUnavailableStateSchema>;
export type GithubActor = Static<typeof GithubActorSchema>;
export type GithubLabel = Static<typeof GithubLabelSchema>;
export type GithubReviewDecision = Static<typeof GithubReviewDecisionSchema>;
export type GithubCheckSummary = Static<typeof GithubCheckSummarySchema>;
export type GithubCheckBucket = Static<typeof GithubCheckBucketSchema>;
export type GithubCheckRun = Static<typeof GithubCheckRunSchema>;
export type GithubPrSummary = Static<typeof GithubPrSummarySchema>;
export type GithubMergeStateStatus = Static<typeof GithubMergeStateStatusSchema>;
export type GithubMergeableState = Static<typeof GithubMergeableStateSchema>;
export type GithubReviewState = Static<typeof GithubReviewStateSchema>;
export type GithubLatestReview = Static<typeof GithubLatestReviewSchema>;
export type GithubPrDetail = Static<typeof GithubPrDetailSchema>;
export type GithubReviewThreadComment = Static<typeof GithubReviewThreadCommentSchema>;
export type GithubReviewThread = Static<typeof GithubReviewThreadSchema>;
export type GithubIssueState = Static<typeof GithubIssueStateSchema>;
export type GithubIssueSummary = Static<typeof GithubIssueSummarySchema>;
export type GithubInboxItem = Static<typeof GithubInboxItemSchema>;
export type GithubPrFilter = Static<typeof GithubPrFilterSchema>;
export type GithubIssueFilter = Static<typeof GithubIssueFilterSchema>;
export type GithubPrsQuery = Static<typeof GithubPrsQuerySchema>;
export type GithubIssuesQuery = Static<typeof GithubIssuesQuerySchema>;
export type GithubInboxQuery = Static<typeof GithubInboxQuerySchema>;
export type GithubPrRefQuery = Static<typeof GithubPrRefQuerySchema>;
export type GithubCreatePrBody = Static<typeof GithubCreatePrBodySchema>;
export type GithubPrActionBody = Static<typeof GithubPrActionBodySchema>;
export type GithubPrsResponse = Static<typeof GithubPrsResponseSchema>;
export type GithubIssuesResponse = Static<typeof GithubIssuesResponseSchema>;
export type GithubInboxResponse = Static<typeof GithubInboxResponseSchema>;
export type GithubPrDetailResponse = Static<typeof GithubPrDetailResponseSchema>;
export type GithubPrChecksResponse = Static<typeof GithubPrChecksResponseSchema>;
export type GithubPrThreadsResponse = Static<typeof GithubPrThreadsResponseSchema>;
export type GithubCreatePrResponse = Static<typeof GithubCreatePrResponseSchema>;
export type GithubPrActionResponse = Static<typeof GithubPrActionResponseSchema>;
