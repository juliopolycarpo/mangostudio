/**
 * ChatGPT OAuth session HTTP routes — thin adapter over the application layer.
 * Parse → call use case → respond. No business logic here.
 */

import type { ChatGptOAuthStatus, StartChatGptOAuthResponse } from '@mangostudio/shared/connectors';
import { StartChatGptOAuthBodySchema } from '@mangostudio/shared/connectors';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  cancelChatGptOAuth,
  getChatGptOAuthStatus,
  startChatGptOAuth,
} from '../application/chatgpt-oauth';
import { handleConnectorError } from './connectors-routes';

export const chatGptOAuthRoutes = new Elysia()
  .use(requireAuth)

  .post(
    '/connectors/chatgpt/oauth/start',
    { body: StartChatGptOAuthBodySchema },
    async ({ body, set, user }): Promise<StartChatGptOAuthResponse | ApiErrorResponse> => {
      try {
        return await startChatGptOAuth(user?.id ?? '', body);
      } catch (error) {
        return handleConnectorError(error, set);
      }
    }
  )

  .get(
    '/connectors/chatgpt/oauth/:sessionId/status',
    { params: t.Object({ sessionId: t.String() }) },
    ({ params, set, user }): ChatGptOAuthStatus | ApiErrorResponse => {
      try {
        return getChatGptOAuthStatus(user?.id ?? '', params.sessionId);
      } catch (error) {
        return handleConnectorError(error, set);
      }
    }
  )

  .post(
    '/connectors/chatgpt/oauth/:sessionId/cancel',
    { params: t.Object({ sessionId: t.String() }) },
    ({ params, set, user }): { success: true } | ApiErrorResponse => {
      try {
        cancelChatGptOAuth(user?.id ?? '', params.sessionId);
        return { success: true };
      } catch (error) {
        return handleConnectorError(error, set);
      }
    }
  );
