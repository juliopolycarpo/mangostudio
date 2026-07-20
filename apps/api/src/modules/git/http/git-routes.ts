import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  type GitRepoState,
  GitRepoStateSchema,
  GitStateQuerySchema,
  InitRepoBodySchema,
  type InitRepoResponse,
  InitRepoResponseSchema,
} from '@mangostudio/shared/git';
import { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { getById } from '../../chats/infrastructure/chat-repository';
import { getRepoState, initRepo } from '../application/git-status-service';
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
  if (error instanceof GitCliError) {
    console.error('[git] command failed', {
      args: error.args,
      exitCode: error.exitCode,
      stderr: error.stderr,
    });
  }
  set.status = 500;
  return { error: 'Git command failed', code: ERROR_CODES.INTERNAL };
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
);
