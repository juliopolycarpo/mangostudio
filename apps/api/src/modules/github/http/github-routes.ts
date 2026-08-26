/**
 * The GitHub rail panel's HTTP surface.
 *
 * Two shapes of route, and the difference is the whole design. Eight are
 * chat-scoped: they resolve the chat's workdir *and* its environment, because
 * `gh` runs on the machine the chat is pinned to and the workdir is a path on
 * that machine. Threading only the workdir is the bug the previous change
 * fixed — it answered about the hub's filesystem and the hub's GitHub account —
 * so `resolveTarget` below returns both or neither, and no handler assembles a
 * selection on its own.
 *
 * The ninth, the inbox, is not chat-scoped at all. "Waiting on your review"
 * spans every repository the account can see, so there is no chat whose workdir
 * would pick one. It takes an `environmentId` to choose whose `gh` answers and
 * runs in that runtime's home directory.
 *
 * No route adds an error code. `gh-not-installed`, `not-authenticated`,
 * `no-remote` and `not-a-github-remote` are 200s carrying a state — a checkout
 * with no GitHub remote is a successful read of a repository that has nothing
 * to say — and `ApiErrorResponse` stays for calls that actually failed.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  GITHUB_LIST_LIMIT_DEFAULT,
  type GithubContext,
  GithubContextQuerySchema,
  GithubContextSchema,
  GithubCreatePrBodySchema,
  type GithubCreatePrResponse,
  GithubCreatePrResponseSchema,
  GithubInboxQuerySchema,
  type GithubInboxResponse,
  GithubInboxResponseSchema,
  GithubIssuesQuerySchema,
  type GithubIssuesResponse,
  GithubIssuesResponseSchema,
  GithubPrActionBodySchema,
  type GithubPrActionResponse,
  GithubPrActionResponseSchema,
  type GithubPrChecksResponse,
  GithubPrChecksResponseSchema,
  type GithubPrDetailResponse,
  GithubPrDetailResponseSchema,
  GithubPrRefQuerySchema,
  GithubPrsQuerySchema,
  type GithubPrsResponse,
  GithubPrsResponseSchema,
  type GithubPrThreadsResponse,
  GithubPrThreadsResponseSchema,
} from '@mangostudio/shared/github';
import { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  chatAccessDenied,
  chatWorkdirConflict,
  resolveChatWorkdir,
} from '../../chats/application/chat-workdir';
import { type GetGithubContext, getGithubContext } from '../application/github-context-service';
import { type GithubReadService, githubReadService } from '../application/github-read-service';
import { type GithubWriteService, githubWriteService } from '../application/github-write-service';
import { GithubOutputError } from '../domain/gh-output';
import { GhCliError, type GhRuntimeSelection } from '../infrastructure/gh-cli';

type RouteResult<T> = T | ApiErrorResponse;

/** Everything a chat-scoped GitHub call needs, resolved once per request. */
interface GithubTarget {
  readonly workdir: string;
  readonly chatId: string;
  readonly selection: GhRuntimeSelection;
}

export interface GithubRouteDeps {
  readonly resolveContext?: GetGithubContext;
  readonly reads?: GithubReadService;
  readonly writes?: GithubWriteService;
}

/** The response codes every GitHub route can answer with, declared once. */
const CHAT_SCOPED_ERRORS = {
  403: ApiErrorResponseSchema,
  404: ApiErrorResponseSchema,
  409: ApiErrorResponseSchema,
  500: ApiErrorResponseSchema,
} as const;

/**
 * Builds the GitHub routes over injected services.
 *
 * @example
 * const routes = createGithubRoutes({ reads: fakeReadService });
 */
export function createGithubRoutes(deps: GithubRouteDeps = {}) {
  const resolveContext = deps.resolveContext ?? getGithubContext;
  const reads = deps.reads ?? githubReadService;
  const writes = deps.writes ?? githubWriteService;

  return new Elysia().use(requireAuth).group('/github', (app) =>
    app
      .get(
        '/context',
        {
          query: GithubContextQuerySchema,
          response: { 200: GithubContextSchema, ...CHAT_SCOPED_ERRORS },
        },
        async ({ query, request, set, user }): Promise<RouteResult<GithubContext>> => {
          const target = await resolveTarget(query.chatId, user?.id ?? '', set);
          if ('error' in target) return target.error;
          return await guard(set, () =>
            resolveContext(target.workdir, target.selection, request.signal)
          );
        }
      )
      .get(
        '/inbox',
        {
          query: GithubInboxQuerySchema,
          response: { 200: GithubInboxResponseSchema, 500: ApiErrorResponseSchema },
        },
        async ({ query, request, set, user }): Promise<RouteResult<GithubInboxResponse>> =>
          await guard(set, () =>
            reads.getInbox({
              // No chat, so no chat to take an environment from: the query says
              // which machine, and absent means this user's local one.
              selection: {
                userId: user?.id ?? '',
                environmentId: query.environmentId ?? LOCAL_ENVIRONMENT_ID,
              },
              limit: query.limit ?? GITHUB_LIST_LIMIT_DEFAULT,
              signal: request.signal,
            })
          )
      )
      .get(
        '/prs',
        {
          query: GithubPrsQuerySchema,
          response: { 200: GithubPrsResponseSchema, ...CHAT_SCOPED_ERRORS },
        },
        async ({ query, request, set, user }): Promise<RouteResult<GithubPrsResponse>> => {
          const target = await resolveTarget(query.chatId, user?.id ?? '', set);
          if ('error' in target) return target.error;
          return await guard(set, () =>
            reads.listPullRequests({
              ...repoRequest(target, request.signal),
              filter: query.filter ?? 'open',
              limit: query.limit ?? GITHUB_LIST_LIMIT_DEFAULT,
            })
          );
        }
      )
      .get(
        '/issues',
        {
          query: GithubIssuesQuerySchema,
          response: { 200: GithubIssuesResponseSchema, ...CHAT_SCOPED_ERRORS },
        },
        async ({ query, request, set, user }): Promise<RouteResult<GithubIssuesResponse>> => {
          const target = await resolveTarget(query.chatId, user?.id ?? '', set);
          if ('error' in target) return target.error;
          return await guard(set, () =>
            reads.listIssues({
              ...repoRequest(target, request.signal),
              filter: query.filter ?? 'open',
              limit: query.limit ?? GITHUB_LIST_LIMIT_DEFAULT,
            })
          );
        }
      )
      .get(
        '/pr',
        {
          query: GithubPrRefQuerySchema,
          response: { 200: GithubPrDetailResponseSchema, ...CHAT_SCOPED_ERRORS },
        },
        async ({ query, request, set, user }): Promise<RouteResult<GithubPrDetailResponse>> => {
          const target = await resolveTarget(query.chatId, user?.id ?? '', set);
          if ('error' in target) return target.error;
          return await guard(set, () =>
            reads.getPullRequest({ ...repoRequest(target, request.signal), number: query.number })
          );
        }
      )
      .get(
        '/pr/checks',
        {
          query: GithubPrRefQuerySchema,
          response: { 200: GithubPrChecksResponseSchema, ...CHAT_SCOPED_ERRORS },
        },
        async ({ query, request, set, user }): Promise<RouteResult<GithubPrChecksResponse>> => {
          const target = await resolveTarget(query.chatId, user?.id ?? '', set);
          if ('error' in target) return target.error;
          return await guard(set, () =>
            reads.getPullRequestChecks({
              ...repoRequest(target, request.signal),
              number: query.number,
            })
          );
        }
      )
      .get(
        '/pr/review-threads',
        {
          query: GithubPrRefQuerySchema,
          response: { 200: GithubPrThreadsResponseSchema, ...CHAT_SCOPED_ERRORS },
        },
        async ({ query, request, set, user }): Promise<RouteResult<GithubPrThreadsResponse>> => {
          const target = await resolveTarget(query.chatId, user?.id ?? '', set);
          if ('error' in target) return target.error;
          return await guard(set, () =>
            reads.getReviewThreads({ ...repoRequest(target, request.signal), number: query.number })
          );
        }
      )
      .post(
        '/pr',
        {
          body: GithubCreatePrBodySchema,
          response: { 200: GithubCreatePrResponseSchema, ...CHAT_SCOPED_ERRORS },
        },
        async ({ body, request, set, user }): Promise<RouteResult<GithubCreatePrResponse>> => {
          const target = await resolveTarget(body.chatId, user?.id ?? '', set);
          if ('error' in target) return target.error;
          return await guard(set, () =>
            writes.createPullRequest(writeRequest(target, request.signal), body)
          );
        }
      )
      .post(
        '/pr/ready',
        {
          body: GithubPrActionBodySchema,
          response: { 200: GithubPrActionResponseSchema, ...CHAT_SCOPED_ERRORS },
        },
        async ({ body, request, set, user }): Promise<RouteResult<GithubPrActionResponse>> => {
          const target = await resolveTarget(body.chatId, user?.id ?? '', set);
          if ('error' in target) return target.error;
          return await guard(set, () =>
            writes.markPullRequestReady(writeRequest(target, request.signal), body)
          );
        }
      )
      .post(
        '/pr/checkout',
        {
          body: GithubPrActionBodySchema,
          response: { 200: GithubPrActionResponseSchema, ...CHAT_SCOPED_ERRORS },
        },
        async ({ body, request, set, user }): Promise<RouteResult<GithubPrActionResponse>> => {
          const target = await resolveTarget(body.chatId, user?.id ?? '', set);
          if ('error' in target) return target.error;
          return await guard(set, () =>
            writes.checkoutPullRequest(writeRequest(target, request.signal), body)
          );
        }
      )
  );
}

export const githubRoutes = createGithubRoutes();

/**
 * Resolves the chat's workdir and the machine it lives on, together.
 *
 * The environment travels with the workdir because one is meaningless without
 * the other: a path on a WSL host read on the hub names a different directory
 * or none at all.
 */
async function resolveTarget(
  chatId: string,
  userId: string,
  set: { status?: number | string }
): Promise<GithubTarget | { error: ApiErrorResponse }> {
  const resolution = await resolveChatWorkdir(chatId, userId, getDb());
  if (resolution.state === 'no-workdir') return { error: chatWorkdirConflict(set) };
  if (resolution.state !== 'ok') return { error: chatAccessDenied(resolution, set) };
  return {
    workdir: resolution.workdir,
    chatId: resolution.chat.id,
    selection: { userId, environmentId: resolution.chat.environmentId },
  };
}

function repoRequest(target: GithubTarget, signal: AbortSignal) {
  return { workdir: target.workdir, selection: target.selection, signal };
}

function writeRequest(target: GithubTarget, signal: AbortSignal) {
  return { ...repoRequest(target, signal), chatId: target.chatId };
}

/**
 * Runs one GitHub call and turns any failure into a fixed 500.
 *
 * gh's own output never reaches the body. Its stderr routinely carries the
 * repository, the branch, the account and occasionally an API URL with a
 * request id — none of which a client asked for — so the detail is logged and
 * the response says only that the read failed.
 */
async function guard<T>(
  set: { status?: number | string },
  run: () => Promise<T>
): Promise<T | ApiErrorResponse> {
  try {
    return await run();
  } catch (error) {
    return githubFailure(error, set);
  }
}

function githubFailure(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof GhCliError) {
    // A cancelled request is the client hanging up, not a server fault worth logging.
    if (!error.aborted) {
      console.error('[github] gh command failed', {
        args: error.args,
        exitCode: error.exitCode,
        stderr: error.stderr,
      });
    }
  } else if (error instanceof GithubOutputError) {
    console.error('[github] invalid gh output', { command: error.command });
  } else {
    console.error('[github] request failed', error);
  }
  set.status = 500;
  return {
    error: 'GitHub context could not be read',
    code: error instanceof GithubOutputError ? error.code : ERROR_CODES.INTERNAL,
  };
}
