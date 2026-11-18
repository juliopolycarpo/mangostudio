import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { TurnRecoveryActionResponse } from '@mangostudio/shared/turn-recovery';
import { type Elysia, status, t } from 'elysia';

import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { reconcileExternalTurns } from '../../external-agents/application/external-turn-recovery';
import { cancelActiveTurn } from '../application/active-turn-registry';
import {
  assertTurnCanCancel,
  dismissInterruptedTurn,
  interruptCheckpointedMessage,
  TurnRecoveryConflictError,
  TurnRecoveryNotFoundError,
} from '../application/turn-recovery';

function handleRecoveryError(error: unknown) {
  if (error instanceof TurnRecoveryNotFoundError) {
    return status(404, { error: error.message, code: ERROR_CODES.NOT_FOUND });
  }
  if (error instanceof TurnRecoveryConflictError) {
    return status(409, { error: error.message, code: ERROR_CODES.CONFLICT });
  }
  throw error;
}

export const turnRecoveryRoutes = (app: Elysia) =>
  app.group('/chats/:id/messages/:messageId/recovery', (app) =>
    app
      .use(requireAuth)
      .post(
        '/dismiss',
        { params: t.Object({ id: t.String(), messageId: t.String() }) },
        async ({ params, user }) => {
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
            return handleRecoveryError(error);
          }
        }
      )
      .post(
        '/cancel',
        { params: t.Object({ id: t.String(), messageId: t.String() }) },
        async ({ params, user }) => {
          const userId = user?.id ?? '';
          try {
            const turn = await assertTurnCanCancel(
              { chatId: params.id, messageId: params.messageId, userId },
              getDb()
            );
            // A live turn finalizes itself from its in-memory state, which is
            // fresher than the last throttled checkpoint. Only reconcile from
            // the row when no stream owns the turn anymore.
            const cancelled = cancelActiveTurn(
              params.messageId,
              userId,
              params.id,
              'user_cancelled'
            );
            if (!cancelled && turn.kind === 'external') {
              // The external record is where an external turn's reason lives;
              // the checkpoint path has nowhere to write one.
              await reconcileExternalTurns(
                { reason: 'cancelled-by-user', messageId: params.messageId },
                getDb()
              );
            } else if (!cancelled) {
              await interruptCheckpointedMessage(
                { messageId: params.messageId, reasonCode: 'user_cancelled' },
                getDb()
              );
            }
            return {
              messageId: params.messageId,
              status: 'interrupted',
            } satisfies TurnRecoveryActionResponse;
          } catch (error) {
            return handleRecoveryError(error);
          }
        }
      )
  );
