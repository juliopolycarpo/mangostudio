import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  CommitBodySchema,
  CommitResponseSchema,
  type GitRepoState,
  GitRepoStateSchema,
  GitStateQuerySchema,
  GitStatusSchema,
  InitRepoBodySchema,
  type InitRepoResponse,
  InitRepoResponseSchema,
  StagePathsBodySchema,
  StashListResponseSchema,
  StashPopBodySchema,
  StashSaveBodySchema,
  UnstagePathsBodySchema,
} from '@mangostudio/shared/git';
import { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { getById } from '../../chats/infrastructure/chat-repository';
import { getRepoState, initRepo } from '../application/git-status-service';
import {
  commitChanges,
  GitWriteError,
  stagePaths,
  stashList,
  stashPop,
  stashSave,
  unstagePaths,
} from '../application/git-write-service';
import { GitCliError } from '../infrastructure/git-cli';

type RouteResult<T> = T | ApiErrorResponse;

function chatAccessError(
  chat: Awaited<ReturnType<typeof getById>>,
  userId: string,
  set: { status?: number | string }
): ApiErrorResponse | null {
  if (!chat) {
    set.status = 404;
    return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
  }
  if (chat.userId !== userId) {
    set.status = 403;
    return { error: 'Chat belongs to another user', code: ERROR_CODES.OWNERSHIP };
  }
  return null;
}

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
    ...(error.detail ? { details: { stderr: error.detail } } : {}),
  };
}

export const gitRoutes = new Elysia().use(requireAuth).group('/git', (app) =>
  app
    .get(
      '/state',
      async ({ query, request, set, user }): Promise<RouteResult<GitRepoState>> => {
        const chat = await getById(query.chatId, getDb());
        const accessError = chatAccessError(chat, user?.id ?? '', set);
        if (accessError) return accessError;
        if (!chat?.workdir) return { state: 'no-workdir' };

        try {
          return await getRepoState(chat.workdir, request.signal);
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
        const chat = await getById(body.chatId, getDb());
        const accessError = chatAccessError(chat, user?.id ?? '', set);
        if (accessError) return accessError;
        if (!chat?.workdir) {
          set.status = 409;
          return { error: 'Chat has no working directory', code: ERROR_CODES.CONFLICT };
        }

        try {
          return await initRepo(chat.workdir, request.signal);
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
        const chat = await getById(body.chatId, getDb());
        const accessError = chatAccessError(chat, user?.id ?? '', set);
        if (accessError) return accessError;
        if (!chat?.workdir) {
          set.status = 409;
          return { error: 'Chat has no working directory', code: ERROR_CODES.CONFLICT };
        }

        try {
          return await stagePaths(chat.workdir, body, request.signal);
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
        const chat = await getById(body.chatId, getDb());
        const accessError = chatAccessError(chat, user?.id ?? '', set);
        if (accessError) return accessError;
        if (!chat?.workdir) {
          set.status = 409;
          return { error: 'Chat has no working directory', code: ERROR_CODES.CONFLICT };
        }

        try {
          return await unstagePaths(chat.workdir, body, request.signal);
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
      '/commit',
      async ({ body, request, set, user }) => {
        const db = getDb();
        const userId = user?.id ?? '';
        const chat = await getById(body.chatId, db);
        const accessError = chatAccessError(chat, userId, set);
        if (accessError) return accessError;
        if (!chat?.workdir) {
          set.status = 409;
          return { error: 'Chat has no working directory', code: ERROR_CODES.CONFLICT };
        }

        try {
          const settings = await getAppSettings(db, userId);
          return await commitChanges(chat.workdir, body, settings.gitSettings, request.signal);
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
    .post(
      '/stash',
      async ({ body, request, set, user }) => {
        const chat = await getById(body.chatId, getDb());
        const accessError = chatAccessError(chat, user?.id ?? '', set);
        if (accessError) return accessError;
        if (!chat?.workdir) {
          set.status = 409;
          return { error: 'Chat has no working directory', code: ERROR_CODES.CONFLICT };
        }

        try {
          return await stashSave(chat.workdir, body, request.signal);
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
        const chat = await getById(body.chatId, getDb());
        const accessError = chatAccessError(chat, user?.id ?? '', set);
        if (accessError) return accessError;
        if (!chat?.workdir) {
          set.status = 409;
          return { error: 'Chat has no working directory', code: ERROR_CODES.CONFLICT };
        }

        try {
          return await stashPop(chat.workdir, body, request.signal);
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
    .get(
      '/stashes',
      async ({ query, request, set, user }) => {
        const chat = await getById(query.chatId, getDb());
        const accessError = chatAccessError(chat, user?.id ?? '', set);
        if (accessError) return accessError;
        if (!chat?.workdir) {
          set.status = 409;
          return { error: 'Chat has no working directory', code: ERROR_CODES.CONFLICT };
        }

        try {
          return await stashList(chat.workdir, request.signal);
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
);
