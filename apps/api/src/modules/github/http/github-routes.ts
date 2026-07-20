import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  type GithubContext,
  GithubContextQuerySchema,
  GithubContextSchema,
} from '@mangostudio/shared/github';
import { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { chatAccessDenied, resolveChatWorkdir } from '../../chats/application/chat-workdir';
import {
  type GetGithubContext,
  GithubContextError,
  getGithubContext,
} from '../application/github-context-service';
import { GhCliError } from '../infrastructure/gh-cli';

type RouteResult = GithubContext | ApiErrorResponse;

export function createGithubRoutes(resolveContext: GetGithubContext = getGithubContext) {
  return new Elysia().use(requireAuth).group('/github', (app) =>
    app.get(
      '/context',
      async ({ query, request, set, user }): Promise<RouteResult> => {
        const resolution = await resolveChatWorkdir(query.chatId, user?.id ?? '', getDb());
        if (resolution.state === 'no-workdir') {
          set.status = 409;
          return { error: 'Chat has no working directory', code: ERROR_CODES.CONFLICT };
        }
        if (resolution.state !== 'ok') return chatAccessDenied(resolution, set);

        try {
          return await resolveContext(resolution.workdir, request.signal);
        } catch (error) {
          if (error instanceof GhCliError) {
            // A cancelled request is the client hanging up, not a server fault worth logging.
            if (!error.aborted) {
              console.error('[github] gh command failed', {
                args: error.args,
                exitCode: error.exitCode,
                stderr: error.stderr,
              });
            }
          } else if (error instanceof GithubContextError) {
            console.error('[github] invalid gh output', { command: error.command });
          } else {
            console.error('[github] context resolution failed', error);
          }
          set.status = 500;
          return {
            error: 'GitHub context could not be read',
            code: error instanceof GithubContextError ? error.code : ERROR_CODES.INTERNAL,
          };
        }
      },
      {
        query: GithubContextQuerySchema,
        response: {
          200: GithubContextSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
  );
}

export const githubRoutes = createGithubRoutes();
