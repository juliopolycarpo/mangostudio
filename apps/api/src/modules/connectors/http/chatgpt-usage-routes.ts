/**
 * ChatGPT usage-action HTTP routes — thin adapter over the application layer.
 * Parse → call use case → respond. No business logic here.
 */

import type {
  ChatGptUsageHistoryResponse,
  ChatGptUsageStatsResponse,
  RedeemChatGptResetCreditResponse,
} from '@mangostudio/shared/connectors';
import { RedeemChatGptResetCreditBodySchema } from '@mangostudio/shared/connectors';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  getChatGptUsageHistory,
  getChatGptUsageStats,
  redeemChatGptResetCredit,
} from '../application/chatgpt-usage';
import { handleConnectorError } from './connectors-routes';

export const chatGptUsageRoutes = new Elysia()
  .use(requireAuth)

  .post(
    '/connectors/:id/usage/reset',
    async ({
      params,
      body,
      set,
      user,
    }): Promise<RedeemChatGptResetCreditResponse | ApiErrorResponse> => {
      try {
        return await redeemChatGptResetCredit(user?.id ?? '', params.id, body.redeemRequestId);
      } catch (error) {
        return handleConnectorError(error, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: RedeemChatGptResetCreditBodySchema,
    }
  )

  .get(
    '/connectors/:id/usage/stats',
    async ({ params, set, user }): Promise<ChatGptUsageStatsResponse | ApiErrorResponse> => {
      try {
        return { stats: await getChatGptUsageStats(user?.id ?? '', params.id) };
      } catch (error) {
        return handleConnectorError(error, set);
      }
    },
    { params: t.Object({ id: t.String() }) }
  )

  .get(
    '/connectors/:id/usage/history',
    async ({
      params,
      query,
      set,
      user,
    }): Promise<ChatGptUsageHistoryResponse | ApiErrorResponse> => {
      try {
        return await getChatGptUsageHistory(
          user?.id ?? '',
          params.id,
          query.window ?? 'secondary',
          query.days ?? 7
        );
      } catch (error) {
        return handleConnectorError(error, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({
        window: t.Optional(t.Union([t.Literal('primary'), t.Literal('secondary')])),
        days: t.Optional(t.Numeric({ minimum: 1, maximum: 90 })),
      }),
    }
  );
