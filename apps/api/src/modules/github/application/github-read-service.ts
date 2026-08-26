/**
 * The six GitHub reads the rail panel makes, behind one cache.
 *
 * Five of them are repository-scoped and share the whole preamble: the
 * availability ladder, the repository they answer about, the cache entry, and
 * the `cachedAt` stamp the panel renders staleness from. `readRepoScoped` is
 * that preamble, so each endpoint below is only the part that differs — which
 * `gh` command, and how its output becomes the contract's shape.
 *
 * The inbox is the exception and is written out separately, because it is not
 * about a repository at all: `gh search prs --review-requested=@me` spans every
 * repository the account can see. It needs no workdir and no remote, only a
 * machine to run on and a directory that exists there.
 */

import type {
  GithubInboxResponse,
  GithubIssueFilter,
  GithubIssuesResponse,
  GithubPrChecksResponse,
  GithubPrDetailResponse,
  GithubPrFilter,
  GithubPrsResponse,
  GithubPrThreadsResponse,
  GithubRepo,
  GithubUnavailableState,
} from '@mangostudio/shared/github';
import { summarizeCheckBuckets } from '../domain/check-rollup';
import {
  GhCheckRunListSchema,
  GhIssueListSchema,
  GhPrDetailOutputSchema,
  GhPrSummaryListSchema,
  GhReviewThreadsOutputSchema,
  GhSearchPrListSchema,
  GithubOutputError,
  readGhOutput,
} from '../domain/gh-output';
import {
  toCheckRuns,
  toInboxItems,
  toIssueSummaries,
  toPrDetail,
  toPrSummaries,
  toReviewThreads,
} from '../domain/github-normalizers';
import {
  type GhRuntimeSelection,
  type GithubCli,
  ghCli,
  resolveGhHomeCwd,
} from '../infrastructure/gh-cli';
import { type GithubCache, githubCache } from './github-cache';
import {
  createGithubRepoResolver,
  type ResolveGithubRepo,
  splitNameWithOwner,
} from './github-repo-resolver';

/** The subject a cross-repo answer is filed under, where a workdir would go. */
const INBOX_SUBJECT = 'inbox';

const EMPTY_CHECK_SUMMARY = { passed: 0, failed: 0, pending: 0, total: 0 } as const;

/** Everything a repository-scoped read needs to reach the right machine. */
export interface GithubRepoRequest {
  readonly workdir: string;
  readonly selection: GhRuntimeSelection;
  readonly signal?: AbortSignal;
}

export interface GithubPrsRequest extends GithubRepoRequest {
  readonly filter: GithubPrFilter;
  readonly limit: number;
}

export interface GithubIssuesRequest extends GithubRepoRequest {
  readonly filter: GithubIssueFilter;
  readonly limit: number;
}

export interface GithubPrRefRequest extends GithubRepoRequest {
  readonly number: number;
}

export interface GithubInboxRequest {
  readonly selection: GhRuntimeSelection;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface GithubReadService {
  readonly listPullRequests: (request: GithubPrsRequest) => Promise<GithubPrsResponse>;
  readonly listIssues: (request: GithubIssuesRequest) => Promise<GithubIssuesResponse>;
  readonly getPullRequest: (request: GithubPrRefRequest) => Promise<GithubPrDetailResponse>;
  readonly getPullRequestChecks: (request: GithubPrRefRequest) => Promise<GithubPrChecksResponse>;
  readonly getReviewThreads: (request: GithubPrRefRequest) => Promise<GithubPrThreadsResponse>;
  readonly getInbox: (request: GithubInboxRequest) => Promise<GithubInboxResponse>;
}

export interface GithubReadServiceOptions {
  readonly client?: GithubCli;
  readonly resolveRepo?: ResolveGithubRepo;
  readonly cache?: GithubCache;
  readonly now?: () => number;
  /** Where an environment-wide `gh` call runs; the inbox has no repository. */
  readonly homeCwd?: (selection: GhRuntimeSelection) => Promise<string>;
}

/**
 * Builds the six reads over one gh facade and one cache.
 *
 * @example
 * const reads = createGithubReadService({ client: fakeCli });
 * await reads.listPullRequests({ workdir, selection, filter: 'open', limit: 20 });
 */
export function createGithubReadService(options: GithubReadServiceOptions = {}): GithubReadService {
  const client = options.client ?? ghCli;
  const resolveRepo = options.resolveRepo ?? createGithubRepoResolver(client);
  const cache = options.cache ?? githubCache;
  const now = options.now ?? Date.now;
  const homeCwd = options.homeCwd ?? resolveGhHomeCwd;

  /**
   * Ladder, cache and `cachedAt` for every repository-scoped read, so each one
   * below only says which command it runs.
   */
  function readRepoScoped<T extends object>(
    request: GithubRepoRequest,
    variant: string,
    load: (repo: GithubRepo) => Promise<T>
  ): Promise<GithubUnavailableState | ({ state: 'ok'; cachedAt: number; repo: GithubRepo } & T)> {
    const scope = { ...request.selection, subject: request.workdir };
    return cache.read(scope, variant, async () => {
      const resolution = await resolveRepo(request.workdir, request.selection, request.signal);
      if (resolution.state !== 'ok') return resolution;
      const payload = await load(resolution.repo);
      return { state: 'ok' as const, cachedAt: now(), repo: resolution.repo, ...payload };
    });
  }

  const target = (request: GithubRepoRequest) => ({
    cwd: request.workdir,
    selection: request.selection,
    ...(request.signal ? { signal: request.signal } : {}),
  });

  /**
   * The one read that is not about a repository.
   *
   * `gh search prs` and `gh auth status` both work outside a git repository, so
   * this needs no workdir and no remote — only a directory that exists on the
   * target machine, which is why the runtime's own home directory is the cwd.
   * The two remote-shaped states in the response union are simply never emitted
   * here; the union stays uniform so the panel keeps one empty-state renderer.
   */
  function readInbox(request: GithubInboxRequest): Promise<GithubInboxResponse> {
    const scope = { ...request.selection, subject: INBOX_SUBJECT };
    return cache.read(scope, `inbox:${request.limit}`, async () => {
      if (!(await client.isAvailable(request.selection))) return { state: 'gh-not-installed' };
      if (!(await client.isAuthenticated(request.selection))) return { state: 'not-authenticated' };

      const result = await client.run(
        'search.prs',
        { limit: request.limit },
        {
          cwd: await homeCwd(request.selection),
          selection: request.selection,
          ...(request.signal ? { signal: request.signal } : {}),
        }
      );
      return {
        state: 'ok' as const,
        cachedAt: now(),
        items: readGhOutput('search.prs', result.stdout, GhSearchPrListSchema, toInboxItems),
      };
    });
  }

  return {
    listPullRequests: (request) =>
      readRepoScoped(request, `prs:${request.filter}:${request.limit}`, async () => {
        const result = await client.run(
          'pr.list',
          { filter: request.filter, limit: request.limit },
          target(request)
        );
        return {
          prs: readGhOutput('pr.list', result.stdout, GhPrSummaryListSchema, toPrSummaries),
        };
      }),

    listIssues: (request) =>
      readRepoScoped(request, `issues:${request.filter}:${request.limit}`, async () => {
        const result = await client.run(
          'issue.list',
          { filter: request.filter, limit: request.limit },
          target(request)
        );
        return {
          issues: readGhOutput('issue.list', result.stdout, GhIssueListSchema, toIssueSummaries),
        };
      }),

    getPullRequest: (request) =>
      readRepoScoped(request, `pr:${request.number}`, async () => {
        const result = await client.run('pr.view', { number: request.number }, target(request));
        return { pr: readGhOutput('pr.view', result.stdout, GhPrDetailOutputSchema, toPrDetail) };
      }),

    getPullRequestChecks: (request) =>
      readRepoScoped(request, `checks:${request.number}`, async () => {
        const result = await client.run('pr.checks', { number: request.number }, target(request));
        // `gh pr checks` exits 1 with an empty stdout when a pull request has no
        // checks at all — the same exit code it uses for a failing check, which
        // the spec accepts so a red pull request can still be read. Blank stdout
        // is that case, and it is an empty list rather than unreadable output.
        //
        // A pull request that does not exist has the same exit code and the same
        // blank stdout, so stdout alone cannot tell the two apart, and reporting
        // "no checks" for a number nobody ever opened is a wrong answer wearing
        // the shape of an ordinary one. gh does distinguish them on stderr, and
        // that is the only signal available without spending a second round trip
        // on `pr view` to ask whether the number resolves.
        if (result.stdout.trim().length === 0) {
          if (isUnresolvedPullRequest(result.stderr)) {
            throw new GithubOutputError('pr.checks');
          }
          return { summary: { ...EMPTY_CHECK_SUMMARY }, checks: [] };
        }
        const checks = readGhOutput('pr.checks', result.stdout, GhCheckRunListSchema, toCheckRuns);
        return { summary: summarizeCheckBuckets(checks), checks };
      }),

    getReviewThreads: (request) =>
      readRepoScoped(request, `threads:${request.number}`, async (repo) => {
        const { owner, name } = splitNameWithOwner(repo.nameWithOwner);
        const result = await client.run(
          'pr.review-threads',
          { owner, name, number: request.number },
          target(request)
        );
        return {
          threads: readGhOutput(
            'pr.review-threads',
            result.stdout,
            GhReviewThreadsOutputSchema,
            toReviewThreads
          ),
        };
      }),

    getInbox: readInbox,
  };
}

/**
 * Whether gh refused because the pull request number does not exist.
 *
 * Matched on stderr because it is the only thing that differs: `gh pr checks`
 * answers a checkless pull request and an imaginary one with the same exit code
 * and the same empty stdout. The phrasing is GitHub's GraphQL resolver rather
 * than gh's own wording, which is why matching it is tolerable — but it is
 * still a string match against a message nobody promised to keep, so it fails
 * *open*: an unrecognised message reads as "no checks", exactly what this code
 * did before, rather than turning some future gh release's unfamiliar phrasing
 * into a broken panel.
 */
function isUnresolvedPullRequest(stderr: string): boolean {
  return /could not resolve to a pullrequest/i.test(stderr);
}

/** The process-wide read service the routes use; tests inject their own. */
export const githubReadService = createGithubReadService();
