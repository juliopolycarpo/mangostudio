import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  CheckoutRemoteBranchBodySchema,
  CommitBodySchema,
  CommitResponseSchema,
  CreateBranchBodySchema,
  DeleteBranchBodySchema,
  DiscardPathsBodySchema,
  GenerateCommitMessageBodySchema,
  type GenerateCommitMessageResponse,
  GenerateCommitMessageResponseSchema,
  GitBranchesResponseSchema,
  GitCommitDetailsResponseSchema,
  GitCommitQuerySchema,
  GitDiffQuerySchema,
  GitDiffResponseSchema,
  GitFetchBodySchema,
  GitHeadMessageResponseSchema,
  GitHistoryQuerySchema,
  GitHistoryResponseSchema,
  GitPushBodySchema,
  GitRemoteBodySchema,
  type GitRepoState,
  GitRepoStateSchema,
  GitStateQuerySchema,
  GitStatusSchema,
  InitRepoBodySchema,
  type InitRepoResponse,
  InitRepoResponseSchema,
  RenameBranchBodySchema,
  StagePathsBodySchema,
  StashApplyBodySchema,
  StashDropBodySchema,
  StashListResponseSchema,
  StashPopBodySchema,
  StashSaveBodySchema,
  SwitchBranchBodySchema,
  UnstagePathsBodySchema,
} from '@mangostudio/shared/git';
import { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import {
  chatAccessDenied,
  chatWorkdirConflict,
  resolveChatWorkdir,
} from '../../chats/application/chat-workdir';
import type { ChatRecord } from '../../chats/infrastructure/chat-repository';
import { NoModelAvailableError } from '../../generation/application/resolve-model';
import {
  EmptyGeneratedCommitMessageError,
  generateCommitMessageUseCase,
  NoCommitChangesError,
} from '../application/generate-commit-message';
import {
  getCommitDetails,
  getFileDiff,
  getHeadMessage,
  listHistory,
} from '../application/git-navigation-service';
import { getRepoState, initRepo } from '../application/git-status-service';
import {
  checkoutRemoteBranch,
  commitChanges,
  createBranch,
  deleteBranch,
  discardPaths,
  fetchRemote,
  GitWriteError,
  listBranches,
  pullFastForward,
  pushBranch,
  renameBranch,
  stagePaths,
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashSave,
  switchBranch,
  unstagePaths,
} from '../application/git-write-service';
import { GitCliError } from '../infrastructure/git-cli';

type RouteResult<T> = T | ApiErrorResponse;

function gitCommandError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  // A cancelled request is the client hanging up, not a server fault worth logging.
  if (error instanceof GitCliError && !error.aborted) {
    console.error('[git] command failed', {
      args: error.args,
      exitCode: error.exitCode,
      stderr: error.stderr,
    });
  }
  set.status = 500;
  return { error: 'Git command failed', code: ERROR_CODES.INTERNAL };
}

function gitWriteError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (!(error instanceof GitWriteError)) return gitCommandError(error, set);
  set.status = error.status;
  return {
    error: error.message,
    code: error.code,
    ...(error.detail
      ? {
          details:
            error.code === ERROR_CODES.CHECKOUT_BLOCKED
              ? { paths: error.detail }
              : { stderr: error.detail },
        }
      : {}),
  };
}

async function routeWorkdir(
  chatId: string,
  userId: string,
  set: { status?: number | string }
): Promise<{ workdir: string; chat: ChatRecord } | { error: ApiErrorResponse }> {
  const resolution = await resolveChatWorkdir(chatId, userId, getDb());
  if (resolution.state === 'ok') {
    return { workdir: resolution.workdir, chat: resolution.chat };
  }
  if (resolution.state === 'no-workdir') {
    return { error: chatWorkdirConflict(set) };
  }
  return { error: chatAccessDenied(resolution, set) };
}

export const gitRoutes = new Elysia().use(requireAuth).group('/git', (app) =>
  app
    .get(
      '/state',
      async ({ query, request, set, user }): Promise<RouteResult<GitRepoState>> => {
        const resolution = await resolveChatWorkdir(query.chatId, user?.id ?? '', getDb());
        if (resolution.state === 'no-workdir') return { state: 'no-workdir' };
        if (resolution.state !== 'ok') return chatAccessDenied(resolution, set);

        try {
          return await getRepoState(resolution.workdir, request.signal);
        } catch (error) {
          return gitCommandError(error, set);
        }
      },
      {
        query: GitStateQuerySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/init',
      async ({ body, request, set, user }): Promise<RouteResult<InitRepoResponse>> => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await initRepo(resolved.workdir, request.signal);
        } catch (error) {
          return gitCommandError(error, set);
        }
      },
      {
        body: InitRepoBodySchema,
        response: {
          200: InitRepoResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/stage',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stagePaths(resolved.workdir, body, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: StagePathsBodySchema,
        response: {
          200: GitStatusSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/unstage',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await unstagePaths(resolved.workdir, body, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: UnstagePathsBodySchema,
        response: {
          200: GitStatusSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/discard',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await discardPaths(resolved.workdir, body, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: DiscardPathsBodySchema,
        response: {
          200: GitStatusSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/commit-message',
      async ({ body, request, set, user }): Promise<RouteResult<GenerateCommitMessageResponse>> => {
        const db = getDb();
        const userId = user?.id ?? '';
        const resolved = await routeWorkdir(body.chatId, userId, set);
        if ('error' in resolved) return resolved.error;
        const { workdir, chat } = resolved;

        try {
          const repoState = await getRepoState(workdir, request.signal);
          if (repoState.state !== 'repo') {
            set.status = 409;
            return {
              error: 'Working directory is not a Git repository',
              code: ERROR_CODES.CONFLICT,
            };
          }
          const settings = await getAppSettings(db, userId);
          return await generateCommitMessageUseCase({
            userId,
            chatId: chat.id,
            repoRoot: repoState.root,
            status: repoState.status,
            requestedModel: body.model,
            preferredModel: settings.gitSettings.commitMessage.preferredModel,
            chatModel: chat.textModel ?? chat.model,
            systemPrompt: settings.gitSettings.commitMessage.systemPrompt,
            maxDiffBytes: settings.gitSettings.commitMessage.maxDiffKb * 1024,
            signal: request.signal,
          });
        } catch (error) {
          if (error instanceof GitCliError) return gitCommandError(error, set);
          if (error instanceof NoCommitChangesError) {
            set.status = 409;
            return { error: error.message, code: ERROR_CODES.NOTHING_TO_COMMIT };
          }
          if (error instanceof EmptyGeneratedCommitMessageError) {
            set.status = 422;
            return { error: error.message, code: ERROR_CODES.GENERATION_EMPTY };
          }
          if (error instanceof NoModelAvailableError) {
            set.status = 503;
            return { error: error.message, code: ERROR_CODES.PROVIDER_ERROR };
          }
          // A cancelled request is the client hanging up, not a server fault worth logging.
          if (!request.signal.aborted) {
            console.error('[git] commit message generation failed', error);
          }
          set.status = 500;
          return { error: 'Commit message generation failed', code: ERROR_CODES.PROVIDER_ERROR };
        }
      },
      {
        body: GenerateCommitMessageBodySchema,
        response: {
          200: GenerateCommitMessageResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
          503: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/commit',
      async ({ body, request, set, user }) => {
        const db = getDb();
        const userId = user?.id ?? '';
        const resolved = await routeWorkdir(body.chatId, userId, set);
        if ('error' in resolved) return resolved.error;

        try {
          const settings = await getAppSettings(db, userId);
          return await commitChanges(resolved.workdir, body, settings.gitSettings, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: CommitBodySchema,
        response: {
          200: CommitResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/head-message',
      async ({ query, request, set, user }) => {
        const db = getDb();
        const userId = user?.id ?? '';
        const resolved = await routeWorkdir(query.chatId, userId, set);
        if ('error' in resolved) return resolved.error;

        try {
          // `/commit` re-adds this user's trailer from the same setting, so the
          // form must not be prefilled with one it would then duplicate.
          const settings = await getAppSettings(db, userId);
          return await getHeadMessage(
            resolved.workdir,
            settings.gitSettings.signOff,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        query: GitStateQuerySchema,
        response: {
          200: GitHeadMessageResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/stash',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stashSave(resolved.workdir, body, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: StashSaveBodySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/stash/pop',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stashPop(resolved.workdir, body, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: StashPopBodySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/stash/apply',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stashApply(resolved.workdir, body, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: StashApplyBodySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/stash/drop',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stashDrop(resolved.workdir, body, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: StashDropBodySchema,
        response: {
          200: StashListResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/stashes',
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stashList(resolved.workdir, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        query: GitStateQuerySchema,
        response: {
          200: StashListResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/branches',
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await listBranches(resolved.workdir, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        query: GitStateQuerySchema,
        response: {
          200: GitBranchesResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/branches/switch',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await switchBranch(resolved.workdir, body.name, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: SwitchBranchBodySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/branches/checkout-remote',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await checkoutRemoteBranch(resolved.workdir, body.remoteRef, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: CheckoutRemoteBranchBodySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/branches',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await createBranch(resolved.workdir, body.name, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: CreateBranchBodySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .delete(
      '/branches',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await deleteBranch(resolved.workdir, body, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: DeleteBranchBodySchema,
        response: {
          200: GitBranchesResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/branches/rename',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await renameBranch(resolved.workdir, body, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: RenameBranchBodySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/history',
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await listHistory(resolved.workdir, query.cursor, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        query: GitHistoryQuerySchema,
        response: {
          200: GitHistoryResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/commit',
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await getCommitDetails(resolved.workdir, query.hash, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        query: GitCommitQuerySchema,
        response: {
          200: GitCommitDetailsResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/diff',
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await getFileDiff(resolved.workdir, query, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        query: GitDiffQuerySchema,
        response: {
          200: GitDiffResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/fetch',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await fetchRemote(resolved.workdir, body.prune ?? false, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: GitFetchBodySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/pull',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await pullFastForward(resolved.workdir, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: GitRemoteBodySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/push',
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await pushBranch(resolved.workdir, body, request.signal);
        } catch (error) {
          return gitWriteError(error, set);
        }
      },
      {
        body: GitPushBodySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
);
