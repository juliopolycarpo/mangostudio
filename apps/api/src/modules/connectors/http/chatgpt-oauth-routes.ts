/**
 * ChatGPT OAuth session HTTP routes — thin adapter over the application layer.
 * Parse → call use case → respond. No business logic here.
 */

import { StartChatGptOAuthBodySchema } from '@mangostudio/shared/connectors';
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
    async ({ body, user }) => {
      try {
        return await startChatGptOAuth(user?.id ?? '', body);
      } catch (error) {
        return handleConnectorError(error);
      }
    }
  )

  .get(
    '/connectors/chatgpt/oauth/:sessionId/status',
    { params: t.Object({ sessionId: t.String() }) },
    ({ params, user }) => {
      try {
        return getChatGptOAuthStatus(user?.id ?? '', params.sessionId);
      } catch (error) {
        return handleConnectorError(error);
      }
    }
  )

  .post(
    '/connectors/chatgpt/oauth/:sessionId/cancel',
    { params: t.Object({ sessionId: t.String() }) },
    ({ params, user }) => {
      try {
        cancelChatGptOAuth(user?.id ?? '', params.sessionId);
        return { success: true as const };
      } catch (error) {
        return handleConnectorError(error);
      }
    }
  );
