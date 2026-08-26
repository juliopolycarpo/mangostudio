/**
 * The three GitHub writes: open a pull request, mark one ready, check one out.
 *
 * Every one of them answers with the pull request *as it now stands*, and `gh`
 * cannot supply that: `pr create` prints a URL, `pr ready` and `pr checkout`
 * print a confirmation line. So each write is a mutation followed by one read
 * of the same row shape the list serves, which is what lets the panel replace a
 * row in place instead of refetching a page to find out what it just did.
 *
 * Each also drops this machine's cached reads and publishes an invalidation.
 * Without both, a user who opens a pull request watches a 60-second-old list
 * that does not contain it — which reads as the button having failed.
 */

import type {
  GithubCreatePrBody,
  GithubCreatePrResponse,
  GithubPrActionBody,
  GithubPrActionResponse,
  GithubPrSummary,
} from '@mangostudio/shared/github';
import {
  requireRepoRoot as requireRepoRootDefault,
  withMutationLock as withMutationLockDefault,
} from '../../git/application/git-write-service';
import { GhPrSummaryOutputSchema, GithubOutputError, readGhOutput } from '../domain/gh-output';
import { toPrSummary } from '../domain/github-normalizers';
import {
  type GhCommandTarget,
  type GhRuntimeSelection,
  type GithubCli,
  ghCli,
} from '../infrastructure/gh-cli';
import { readCurrentBranch, readPullRequestTemplate } from '../infrastructure/pull-request-inputs';
import { type GithubCache, githubCache } from './github-cache';
import {
  type GithubWriteOperation,
  publishGithubWriteInvalidation,
} from './github-realtime-service';
import { createGithubRepoResolver, type ResolveGithubRepo } from './github-repo-resolver';

/** `https://github.com/owner/repo/pull/123` — the only thing `pr create` prints. */
const PR_URL_NUMBER_PATTERN = /\/pull\/(\d+)\b/;

/** What every write needs to reach the right checkout on the right machine. */
export interface GithubWriteRequest {
  readonly workdir: string;
  readonly chatId: string;
  readonly selection: GhRuntimeSelection;
  readonly signal?: AbortSignal;
}

export interface GithubWriteService {
  readonly createPullRequest: (
    request: GithubWriteRequest,
    body: GithubCreatePrBody
  ) => Promise<GithubCreatePrResponse>;
  readonly markPullRequestReady: (
    request: GithubWriteRequest,
    body: GithubPrActionBody
  ) => Promise<GithubPrActionResponse>;
  readonly checkoutPullRequest: (
    request: GithubWriteRequest,
    body: GithubPrActionBody
  ) => Promise<GithubPrActionResponse>;
}

export interface GithubWriteServiceOptions {
  readonly client?: GithubCli;
  readonly resolveRepo?: ResolveGithubRepo;
  readonly cache?: GithubCache;
  /** Injected so a test can open a pull request without a git checkout. */
  readonly currentBranch?: (request: GithubWriteRequest) => Promise<string>;
  /** Injected so a test can supply a template without a filesystem. */
  readonly pullRequestTemplate?: (request: GithubWriteRequest) => Promise<string>;
  readonly publish?: typeof publishGithubWriteInvalidation;
  /**
   * Injected so a test can serialize a checkout without a real git checkout
   * or the runtime connection `requireRepoRoot` resolves it through.
   */
  readonly requireRepoRoot?: typeof requireRepoRootDefault;
  readonly withMutationLock?: typeof withMutationLockDefault;
}

/**
 * Builds the three writes over one gh facade.
 *
 * @example
 * const writes = createGithubWriteService({ client: fakeCli });
 * await writes.markPullRequestReady(request, { chatId, number: 42 });
 */
export function createGithubWriteService(
  options: GithubWriteServiceOptions = {}
): GithubWriteService {
  const client = options.client ?? ghCli;
  const resolveRepo = options.resolveRepo ?? createGithubRepoResolver(client);
  const cache = options.cache ?? githubCache;
  const currentBranch = options.currentBranch ?? readCurrentBranch;
  const pullRequestTemplate =
    options.pullRequestTemplate ??
    ((request: GithubWriteRequest) => readPullRequestTemplate(request, request.chatId));
  const publish = options.publish ?? publishGithubWriteInvalidation;
  const requireRepoRoot = options.requireRepoRoot ?? requireRepoRootDefault;
  const withMutationLock = options.withMutationLock ?? withMutationLockDefault;

  const target = (request: GithubWriteRequest): GhCommandTarget => ({
    cwd: request.workdir,
    selection: request.selection,
    ...(request.signal ? { signal: request.signal } : {}),
  });

  /** Reads back the row the panel will render, after the mutation succeeded. */
  async function readSummary(
    request: GithubWriteRequest,
    number: number
  ): Promise<GithubPrSummary> {
    const result = await client.run('pr.view-summary', { number }, target(request));
    return readGhOutput('pr.view-summary', result.stdout, GhPrSummaryOutputSchema, toPrSummary);
  }

  /** Drops the stale reads and tells the panel, in that order. */
  function settle(request: GithubWriteRequest, operation: GithubWriteOperation): void {
    cache.clear(request.selection);
    publish({ userId: request.selection.userId, chatId: request.chatId }, operation);
  }

  /**
   * `pr ready` and `pr checkout` differ only in the command they run, so they
   * share the ladder, the read-back and the invalidation rather than repeating
   * them — which is also how the two stay unable to drift apart.
   */
  async function runPrAction(
    request: GithubWriteRequest,
    number: number,
    command: 'pr.ready' | 'pr.checkout',
    operation: GithubWriteOperation
  ): Promise<GithubPrActionResponse> {
    const resolution = await resolveRepo(request.workdir, request.selection, request.signal);
    if (resolution.state !== 'ok') return resolution;

    const runMutation = () => client.run(command, { number }, target(request));
    // `pr checkout` fetches a ref and switches the working tree, exactly what
    // the git write service's own mutations do — and it runs outside their
    // queue unless it takes the same lock. Serializing it here is what stops
    // a checkout from racing a stage, commit, branch switch, or worktree
    // operation on the same repository against a moving index or working tree.
    if (command === 'pr.checkout') {
      const root = await requireRepoRoot(request.workdir, request.signal, request.selection);
      await withMutationLock(request.selection.environmentId, root, runMutation);
    } else {
      await runMutation();
    }
    // The mutation already landed on GitHub or the working tree at this
    // point; only the convenience readback below can still fail. Settling
    // first means an aborted, timed-out, or unparseable readback still leaves
    // the cache and realtime subscribers correct, instead of quietly keeping
    // the pre-mutation state and inviting a retry of something that already
    // happened.
    settle(request, operation);
    const pr = await readSummary(request, number);
    return { state: 'ok', pr };
  }

  return {
    async createPullRequest(request, body) {
      const resolution = await resolveRepo(request.workdir, request.selection, request.signal);
      if (resolution.state !== 'ok') return resolution;

      // Two independent round trips to a runtime that may be a container or
      // another machine — a branch read and a template file read — so they go
      // out together rather than one after the other.
      //
      // Empty is a legitimate body and still passed as `--body=`: omitting the
      // flag is what sends gh to the interactive editor, which cannot open
      // under `GH_PROMPT_DISABLED=1`.
      const [head, prBody] = await Promise.all([
        currentBranch(request),
        body.body ?? pullRequestTemplate(request),
      ]);
      const created = await client.run(
        'pr.create',
        {
          title: body.title,
          body: prBody,
          head,
          draft: body.draft ?? false,
          ...(body.base ? { base: body.base } : {}),
        },
        target(request)
      );

      // Same ordering as runPrAction, and for the same reason: gh pr create
      // already opened the pull request by the time this line runs, so
      // settling before parsing its URL and reading it back keeps a
      // malformed readback from masking a mutation that already succeeded.
      settle(request, 'create');
      const number = parsePullRequestNumber(created.stdout);
      const pr = await readSummary(request, number);
      return { state: 'ok', repo: resolution.repo, pr };
    },

    async markPullRequestReady(request, body) {
      return await runPrAction(request, body.number, 'pr.ready', 'ready');
    },

    async checkoutPullRequest(request, body) {
      return await runPrAction(request, body.number, 'pr.checkout', 'checkout');
    },
  };
}

/** The process-wide write service the routes use; tests inject their own. */
export const githubWriteService = createGithubWriteService();

/**
 * Recovers the new pull request's number from the URL `gh pr create` prints.
 *
 * The alternative — a bare `gh pr view` on the current branch — would answer
 * about whatever branch the working tree is on by the time it runs, which is
 * not necessarily the branch that was just used.
 */
function parsePullRequestNumber(stdout: string): number {
  const match = PR_URL_NUMBER_PATTERN.exec(stdout);
  if (!match?.[1]) throw new GithubOutputError('pr.create');
  return Number.parseInt(match[1], 10);
}
