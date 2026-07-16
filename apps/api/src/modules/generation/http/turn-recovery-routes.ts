import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { TurnRecoveryActionResponse } from '@mangostudio/shared/turn-recovery';
import { type Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { cancelActiveTurn } from '../application/active-turn-registry';
import {
  assertCheckpointedTurnCanCancel,
  dismissInterruptedTurn,
  interruptCheckpointedMessage,
  TurnRecoveryConflictError,
  TurnRecoveryNotFoundError,
} from '../application/turn-recovery';

function handleRecoveryError(error: unknown, set: { status?: number | string }) {
  if (error instanceof TurnRecoveryNotFoundError) {
    set.status = 404;
    return { error: error.message, code: ERROR_CODES.NOT_FOUND };
  }
  if (error instanceof TurnRecoveryConflictError) {
    set.status = 409;
    return { error: error.message, code: ERROR_CODES.CONFLICT };
  }
  throw error;
}

export const turnRecoveryRoutes = (app: Elysia) =>
  app.group('/chats/:id/messages/:messageId/recovery', (app) =>
    app
      .use(requireAuth)
      .post(
        '/dismiss',
        async ({ params, user, set }) => {
          try {
            await dismissInterruptedTurn(
              {
                chatId: params.id,
                messageId: params.messageId,
                userId: user?.id ?? '',
              },
              getDb()
            );
            return {
              messageId: params.messageId,
              status: 'dismissed',
            } satisfies TurnRecoveryActionResponse;
          } catch (error) {
            return handleRecoveryError(error, set);
          }
        },
        { params: t.Object({ id: t.String(), messageId: t.String() }) }
      )
      .post(
        '/cancel',
        async ({ params, user, set }) => {
          const userId = user?.id ?? '';
          try {
            await assertCheckpointedTurnCanCancel(
              { chatId: params.id, messageId: params.messageId, userId },
              getDb()
            );
            cancelActiveTurn(params.messageId, userId, params.id, 'user_cancelled');
            await interruptCheckpointedMessage(
              { messageId: params.messageId, reasonCode: 'user_cancelled' },
              getDb()
            );
            return {
              messageId: params.messageId,
              status: 'interrupted',
            } satisfies TurnRecoveryActionResponse;
          } catch (error) {
            return handleRecoveryError(error, set);
          }
        },
        { params: t.Object({ id: t.String(), messageId: t.String() }) }
      )
  );
