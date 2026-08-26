/**
 * Every `gh` invocation this product can make, as a closed set of specs.
 *
 * The hub used to build `gh` argv wherever it needed one, and guarded that with
 * a `Set` of `JSON.stringify(argv)` — which only works while every command is a
 * constant. The GitHub panel's commands are not: they carry a filter, a page
 * size, a pull request number, and a title and body a person typed. So the
 * shape changed rather than the guard being loosened: a command is a fixed argv
 * prefix plus *validated slots*, and `buildGhCommandArgv` is the only function
 * in the hub allowed to produce a `gh` argv.
 *
 * Two properties are load-bearing, and both are tested rather than commented:
 *
 *   1. **Every free-text value is emitted as a single `--flag=value` token.**
 *      `Bun.spawn` takes argv directly, so there is no shell and no quoting bug
 *      to have. The exposure is Go's pflag: `gh` parses its own argv, and a
 *      title of `--repo evil/repo` split across two tokens would be read as a
 *      flag rather than as text. The `=` form is unambiguous whatever the value
 *      starts with, which is why `flagValue()` below is the only way a spec is
 *      permitted to spell a valued flag.
 *
 *      `--body-file` looks like the safer answer and is not available: the
 *      runtime receives argv and a cwd, so a temp file the hub wrote does not
 *      exist on the machine `gh` runs on, and the runner sets `stdin: 'ignore'`.
 *      Argv is the only channel, and the `=` form is what makes it safe. Git's
 *      side already carries a free-text commit message the same way — see
 *      `modules/git/domain/commit-command.ts`.
 *
 *   2. **Nothing a user typed ever selects a flag.** Filters are TypeBox
 *      literal unions mapping to fixed argv fragments, so `filter=mine` picks
 *      `--author=@me` from this file rather than reaching `gh` verbatim.
 *
 * The runtime keeps its own subcommand allowlist (`apps/runtime/src/services/gh.ts`)
 * and is the actual trust boundary. This registry stays inside it by
 * construction: every spec's prefix is one of the subcommands that boundary
 * accepts, so a spec that drifted out of the allowlist fails at the runtime
 * rather than running.
 */

import {
  GITHUB_PR_REVIEW_THREADS_QUERY,
  type GithubIssueFilter,
  GithubIssueFilterSchema,
  type GithubPrFilter,
  GithubPrFilterSchema,
} from '@mangostudio/shared/github';
import Type, { type Static, type TSchema } from 'typebox';
import Value from 'typebox/value';

/** `--json` field lists, one per read. Constants, so they are never slots. */
const GH_REPO_FIELDS = 'nameWithOwner,defaultBranchRef,url';
const GH_PR_CONTEXT_FIELDS = 'number,title,state,isDraft,url,headRefName,baseRefName';
const GH_PR_SUMMARY_FIELDS =
  'number,title,url,state,isDraft,headRefName,baseRefName,updatedAt,author,labels,reviewDecision,statusCheckRollup';
const GH_PR_DETAIL_FIELDS =
  'number,title,body,url,reviewDecision,mergeStateStatus,mergeable,changedFiles,additions,deletions,latestReviews,labels';
const GH_PR_CHECK_FIELDS = 'name,state,bucket,link,workflow,description,startedAt,completedAt';
const GH_ISSUE_FIELDS = 'number,title,url,state,updatedAt,author,labels,assignees';
const GH_SEARCH_PR_FIELDS = 'number,title,url,state,isDraft,updatedAt,author,labels,repository';

/**
 * `gh pr checks` exits non-zero to *report*, not only to fail: 1 when a check
 * failed and 8 when one is still pending (`gh pr checks --help`, "Additional
 * exit codes"). It prints the JSON either way, so treating those as errors
 * would 500 the checks panel on every red or running pull request — which is
 * the state a person opens that panel to look at.
 */
const PR_CHECKS_ACCEPTED_EXIT_CODES: readonly number[] = [1, 8];

/**
 * Page size, matching the contract's own cap. Redeclared here rather than
 * imported because the contract keeps it private: this is the argv-side bound,
 * and a slot has to validate whatever reaches it, not whatever an HTTP layer
 * happened to check first.
 */
const LimitSchema = Type.Integer({ minimum: 1, maximum: 30 });

/** A pull request number. `minimum: 1` is what keeps a positional from ever starting with `-`. */
const PrNumberSchema = Type.Integer({ minimum: 1 });

/**
 * One half of a `owner/name` — GitHub's own character set for both.
 *
 * Patterned rather than free text because these two reach `gh api graphql` as
 * `-f key=value` *pairs*, which is the one place the `=`-form defence below
 * cannot apply: the runtime's GraphQL validator walks the argv two tokens at a
 * time from index 2, so a fused `-f=owner=x` token would be rejected as an
 * unknown flag. Constraining the values instead is what makes the pair form
 * safe there.
 */
const RepoNamePartSchema = Type.String({ minLength: 1, maxLength: 100, pattern: '^[\\w.-]+$' });

const NoParamsSchema = Type.Object({});

const PrListParamsSchema = Type.Object({ filter: GithubPrFilterSchema, limit: LimitSchema });
const IssueListParamsSchema = Type.Object({ filter: GithubIssueFilterSchema, limit: LimitSchema });
const SearchPrsParamsSchema = Type.Object({ limit: LimitSchema });
const PrRefParamsSchema = Type.Object({ number: PrNumberSchema });
const ReviewThreadsParamsSchema = Type.Object({
  owner: RepoNamePartSchema,
  name: RepoNamePartSchema,
  number: PrNumberSchema,
});
const CreatePrParamsSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  body: Type.String(),
  head: Type.String({ minLength: 1 }),
  draft: Type.Boolean(),
  base: Type.Optional(Type.String({ minLength: 1 })),
});

/**
 * A single `gh` command: its slot contract, which runtime method it belongs to,
 * and the pure function that turns validated slots into argv.
 */
export interface GhCommandSpec<P> {
  readonly id: GhCommandId;
  /** The slot contract. `buildGhCommandArgv` checks against it before `argv` runs. */
  readonly params: TSchema;
  /** True routes the call to `gh.mutate`; false to `gh.exec`. */
  readonly mutation: boolean;
  /** Non-zero exits this command uses to report rather than to fail. */
  readonly acceptedExitCodes?: readonly number[];
  /** Pure. The only code in the hub permitted to build a `gh` argv. */
  readonly argv: (params: P) => readonly string[];
}

/**
 * The only way a spec may spell a flag that carries a value.
 *
 * One token, always, so pflag reads the value as a value however it starts.
 * Centralised so no individual spec can quietly reintroduce the two-token form
 * that a `--`-leading title would turn into a flag.
 */
function flagValue(name: string, value: string | number): string {
  return `--${name}=${value}`;
}

/**
 * `mine` and `review-requested` pick argv from here; the query string never does.
 *
 * `--state` lives in this map rather than beside `pr list` because `all` is the
 * one filter that changes it. The three open views keep the state token first so
 * their argv is byte-identical to when it was hardcoded — a filter is a choice of
 * flags, and this is the only table that gets to make it.
 */
const PR_FILTER_ARGV: Record<GithubPrFilter, readonly string[]> = {
  open: ['--state=open'],
  mine: ['--state=open', '--author=@me'],
  'review-requested': ['--state=open', '--search=review-requested:@me'],
  all: ['--state=all'],
};

const ISSUE_FILTER_ARGV: Record<GithubIssueFilter, readonly string[]> = {
  open: [],
  assigned: ['--assignee=@me'],
  mine: ['--author=@me'],
};

const GH_COMMANDS = {
  'auth.status': {
    id: 'auth.status',
    params: NoParamsSchema,
    mutation: false,
    argv: () => ['auth', 'status'],
  },
  'repo.view': {
    id: 'repo.view',
    params: NoParamsSchema,
    mutation: false,
    argv: () => ['repo', 'view', '--json', GH_REPO_FIELDS],
  },
  'pr.view-current': {
    id: 'pr.view-current',
    params: NoParamsSchema,
    mutation: false,
    argv: () => ['pr', 'view', '--json', GH_PR_CONTEXT_FIELDS],
  },
  'pr.list': {
    id: 'pr.list',
    params: PrListParamsSchema,
    mutation: false,
    argv: (params: Static<typeof PrListParamsSchema>) => [
      'pr',
      'list',
      ...PR_FILTER_ARGV[params.filter],
      flagValue('limit', params.limit),
      '--json',
      GH_PR_SUMMARY_FIELDS,
    ],
  },
  'pr.view': {
    id: 'pr.view',
    params: PrRefParamsSchema,
    mutation: false,
    argv: (params: Static<typeof PrRefParamsSchema>) => [
      'pr',
      'view',
      String(params.number),
      '--json',
      GH_PR_DETAIL_FIELDS,
    ],
  },
  'pr.view-summary': {
    id: 'pr.view-summary',
    params: PrRefParamsSchema,
    mutation: false,
    argv: (params: Static<typeof PrRefParamsSchema>) => [
      'pr',
      'view',
      String(params.number),
      '--json',
      GH_PR_SUMMARY_FIELDS,
    ],
  },
  'pr.checks': {
    id: 'pr.checks',
    params: PrRefParamsSchema,
    mutation: false,
    acceptedExitCodes: PR_CHECKS_ACCEPTED_EXIT_CODES,
    argv: (params: Static<typeof PrRefParamsSchema>) => [
      'pr',
      'checks',
      String(params.number),
      '--json',
      GH_PR_CHECK_FIELDS,
    ],
  },
  'pr.review-threads': {
    id: 'pr.review-threads',
    params: ReviewThreadsParamsSchema,
    mutation: false,
    // Pair tokens, not the `=` form used everywhere else: the runtime's
    // pinned-document validator walks `gh api graphql` argv two at a time from
    // index 2, so a fused token would fail its field-flag check. Safe because
    // every value here is a checked integer or a `RepoNamePartSchema` match.
    argv: (params: Static<typeof ReviewThreadsParamsSchema>) => [
      'api',
      'graphql',
      '-f',
      `query=${GITHUB_PR_REVIEW_THREADS_QUERY}`,
      '-f',
      `owner=${params.owner}`,
      '-f',
      `name=${params.name}`,
      '-F',
      `number=${params.number}`,
    ],
  },
  'issue.list': {
    id: 'issue.list',
    params: IssueListParamsSchema,
    mutation: false,
    argv: (params: Static<typeof IssueListParamsSchema>) => [
      'issue',
      'list',
      '--state=open',
      ...ISSUE_FILTER_ARGV[params.filter],
      flagValue('limit', params.limit),
      '--json',
      GH_ISSUE_FIELDS,
    ],
  },
  'search.prs': {
    id: 'search.prs',
    params: SearchPrsParamsSchema,
    mutation: false,
    argv: (params: Static<typeof SearchPrsParamsSchema>) => [
      'search',
      'prs',
      '--review-requested=@me',
      '--state=open',
      flagValue('limit', params.limit),
      '--json',
      GH_SEARCH_PR_FIELDS,
    ],
  },
  'pr.create': {
    id: 'pr.create',
    params: CreatePrParamsSchema,
    mutation: true,
    // `--head` is always passed. gh's own documentation for it: when the current
    // branch is not fully pushed, gh prompts for where to push — and the runner
    // sets `GH_PROMPT_DISABLED=1`, so that prompt is a failure rather than a
    // question. Naming the head branch skips the forking/pushing path entirely;
    // pushing first is the caller's job.
    argv: (params: Static<typeof CreatePrParamsSchema>) => [
      'pr',
      'create',
      flagValue('title', params.title),
      // Emitted even when empty. Omitting `--body` is what sends gh to the
      // interactive editor, which is the same prompt-disabled dead end.
      flagValue('body', params.body),
      flagValue('head', params.head),
      ...(params.base ? [flagValue('base', params.base)] : []),
      ...(params.draft ? ['--draft'] : []),
    ],
  },
  'pr.ready': {
    id: 'pr.ready',
    params: PrRefParamsSchema,
    mutation: true,
    argv: (params: Static<typeof PrRefParamsSchema>) => ['pr', 'ready', String(params.number)],
  },
  'pr.checkout': {
    id: 'pr.checkout',
    params: PrRefParamsSchema,
    mutation: true,
    argv: (params: Static<typeof PrRefParamsSchema>) => ['pr', 'checkout', String(params.number)],
  },
} as const;

type GhCommandRegistry = typeof GH_COMMANDS;

/** Every `gh` command this product can run. */
export type GhCommandId = keyof GhCommandRegistry;

/** The validated slots one command takes. */
export type GhCommandParams<I extends GhCommandId> =
  GhCommandRegistry[I] extends GhCommandSpec<infer P> ? P : never;

/**
 * Every spec, for callers that need a command's runtime method or its accepted
 * exit codes, and for the tests that sweep the whole registry.
 */
export const GH_COMMAND_SPECS: Readonly<Record<GhCommandId, GhCommandSpec<never>>> = GH_COMMANDS;

/**
 * Validates slots against the spec's schema, then lets only the spec build argv.
 *
 * Throws rather than returning a partial argv: a slot that failed its contract
 * is a programming error on the hub's side, and the alternative is running a
 * `gh` command nobody wrote.
 *
 * @example
 * buildGhCommandArgv('pr.list', { filter: 'mine', limit: 20 });
 * // ['pr', 'list', '--state=open', '--author=@me', '--limit=20', '--json', '...']
 */
export function buildGhCommandArgv<I extends GhCommandId>(
  id: I,
  params: GhCommandParams<I>
): readonly string[] {
  const spec = GH_COMMANDS[id];
  if (!Value.Check(spec.params, params)) {
    throw new TypeError(`Invalid parameters for gh command "${id}".`);
  }
  return (spec.argv as (value: GhCommandParams<I>) => readonly string[])(params);
}
