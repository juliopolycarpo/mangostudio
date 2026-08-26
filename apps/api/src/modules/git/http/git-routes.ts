import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  AddWorktreeBodySchema,
  CheckoutRemoteBranchBodySchema,
  CommitBodySchema,
  CommitResponseSchema,
  CreateBranchBodySchema,
  DeleteBranchBodySchema,
  DiscardPathsBodySchema,
  GenerateCommitMessageBodySchema,
  type GenerateCommitMessageResponse,
  GenerateCommitMessageResponseSchema,
  GitBatchStateRequestSchema,
  type GitBatchStateResponse,
  GitBatchStateResponseSchema,
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
  GitWorktreeListResponseSchema,
  InitRepoBodySchema,
  type InitRepoResponse,
  InitRepoResponseSchema,
  RemoveWorktreeBodySchema,
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
import { type ChatRecord, listByIdsForUser } from '../../chats/infrastructure/chat-repository';
import { NoModelAvailableError } from '../../generation/application/resolve-model';
import { modelUnavailableResponse } from '../../generation/http/model-unavailable-response';
import {
  EmptyGeneratedCommitMessageError,
  generateCommitMessageUseCase,
  NoCommitChangesError,
} from '../application/generate-commit-message';
import { getBatchGitSummaries } from '../application/git-batch-status-service';
import {
  getCommitDetails,
  getFileDiff,
  getHeadMessage,
  listHistory,
} from '../application/git-navigation-service';
import type { GitInvalidationTarget } from '../application/git-realtime-service';
import { getRepoState } from '../application/git-status-service';
import { addWorktree, listWorktrees, removeWorktree } from '../application/git-worktree-service';
import {
  checkoutRemoteBranch,
  commitChanges,
  createBranch,
  deleteBranch,
  discardPaths,
  fetchRemote,
  GitWriteError,
  initRepo,
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
): Promise<
  | { workdir: string; chat: ChatRecord; invalidationTarget: GitInvalidationTarget }
  | { error: ApiErrorResponse }
> {
  const resolution = await resolveChatWorkdir(chatId, userId, getDb());
  if (resolution.state === 'ok') {
    return {
      workdir: resolution.workdir,
      chat: resolution.chat,
      invalidationTarget: {
        userId,
        chatId: resolution.chat.id,
        environmentId: resolution.chat.environmentId,
      },
    };
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
      {
        query: GitStateQuerySchema,
        response: {
          200: GitRepoStateSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ query, request, set, user }): Promise<RouteResult<GitRepoState>> => {
        const resolution = await resolveChatWorkdir(query.chatId, user?.id ?? '', getDb());
        if (resolution.state === 'no-workdir') return { state: 'no-workdir' };
        if (resolution.state !== 'ok') return chatAccessDenied(resolution, set);

        try {
          return await getRepoState(resolution.workdir, request.signal, {
            userId: user?.id ?? '',
            environmentId: resolution.chat.environmentId,
          });
        } catch (error) {
          return gitCommandError(error, set);
        }
      }
    )
    .post(
      '/state/batch',
      {
        body: GitBatchStateRequestSchema,
        response: {
          200: GitBatchStateResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ body, request, set, user }): Promise<RouteResult<GitBatchStateResponse>> => {
        const userId = user?.id ?? '';
        // The ownership lookup is a database read, not Git. It stays outside
        // the catch — like `resolveChatWorkdir` on every sibling route — so a
        // storage failure is not reported (and silently unlogged) as
        // "Git command failed".
        const chats = await listByIdsForUser(body.chatIds, userId, getDb());
        try {
          return {
            states: await getBatchGitSummaries({
              chatIds: body.chatIds,
              chats,
              userId,
              signal: request.signal,
            }),
          };
        } catch (error) {
          return gitCommandError(error, set);
        }
      }
    )
    .post(
      '/init',
      {
        body: InitRepoBodySchema,
        response: {
          200: InitRepoResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ body, request, set, user }): Promise<RouteResult<InitRepoResponse>> => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await initRepo(resolved.workdir, resolved.invalidationTarget, request.signal);
        } catch (error) {
          return gitCommandError(error, set);
        }
      }
    )
    .post(
      '/stage',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stagePaths(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/unstage',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await unstagePaths(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/discard',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await discardPaths(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/commit-message',
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
      },
      async ({ body, request, set, user }): Promise<RouteResult<GenerateCommitMessageResponse>> => {
        const db = getDb();
        const userId = user?.id ?? '';
        const resolved = await routeWorkdir(body.chatId, userId, set);
        if ('error' in resolved) return resolved.error;
        const { workdir, chat } = resolved;

        try {
          const repoState = await getRepoState(
            workdir,
            request.signal,
            resolved.invalidationTarget
          );
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
            environmentId: chat.environmentId,
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
            const refusal = modelUnavailableResponse(error);
            set.status = refusal.status;
            return refusal.body;
          }
          // A cancelled request is the client hanging up, not a server fault worth logging.
          if (!request.signal.aborted) {
            console.error('[git] commit message generation failed', error);
          }
          set.status = 500;
          return { error: 'Commit message generation failed', code: ERROR_CODES.PROVIDER_ERROR };
        }
      }
    )
    .post(
      '/commit',
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
      },
      async ({ body, request, set, user }) => {
        const db = getDb();
        const userId = user?.id ?? '';
        const resolved = await routeWorkdir(body.chatId, userId, set);
        if ('error' in resolved) return resolved.error;

        try {
          const settings = await getAppSettings(db, userId);
          return await commitChanges(
            resolved.workdir,
            body,
            settings.gitSettings,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .get(
      '/head-message',
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
      },
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
            request.signal,
            resolved.invalidationTarget
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/stash',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stashSave(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/stash/pop',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stashPop(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/stash/apply',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stashApply(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/stash/drop',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stashDrop(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .get(
      '/stashes',
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
      },
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;

        try {
          return await stashList(resolved.workdir, request.signal, resolved.invalidationTarget);
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .get(
      '/branches',
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
      },
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await listBranches(resolved.workdir, request.signal, resolved.invalidationTarget);
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/branches/switch',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await switchBranch(
            resolved.workdir,
            body.name,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/branches/checkout-remote',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await checkoutRemoteBranch(
            resolved.workdir,
            body.remoteRef,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/branches',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await createBranch(
            resolved.workdir,
            body.name,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .delete(
      '/branches',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await deleteBranch(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/branches/rename',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await renameBranch(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .get(
      '/worktrees',
      {
        query: GitStateQuerySchema,
        response: {
          200: GitWorktreeListResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await listWorktrees(resolved.workdir, request.signal, resolved.invalidationTarget);
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/worktrees',
      {
        body: AddWorktreeBodySchema,
        response: {
          200: GitWorktreeListResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await addWorktree(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .delete(
      '/worktrees',
      {
        body: RemoveWorktreeBodySchema,
        response: {
          200: GitWorktreeListResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await removeWorktree(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .get(
      '/history',
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
      },
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await listHistory(
            resolved.workdir,
            query.cursor,
            request.signal,
            resolved.invalidationTarget
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .get(
      '/commit',
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
      },
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await getCommitDetails(
            resolved.workdir,
            query.hash,
            request.signal,
            resolved.invalidationTarget
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .get(
      '/diff',
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
      },
      async ({ query, request, set, user }) => {
        const resolved = await routeWorkdir(query.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await getFileDiff(
            resolved.workdir,
            query,
            request.signal,
            resolved.invalidationTarget
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/fetch',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await fetchRemote(
            resolved.workdir,
            body.prune ?? false,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/pull',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await pullFastForward(
            resolved.workdir,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
    .post(
      '/push',
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
      },
      async ({ body, request, set, user }) => {
        const resolved = await routeWorkdir(body.chatId, user?.id ?? '', set);
        if ('error' in resolved) return resolved.error;
        try {
          return await pushBranch(
            resolved.workdir,
            body,
            resolved.invalidationTarget,
            request.signal
          );
        } catch (error) {
          return gitWriteError(error, set);
        }
      }
    )
);
