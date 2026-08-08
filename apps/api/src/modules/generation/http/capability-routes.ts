import { ChatCapabilitiesQuerySchema } from '@mangostudio/shared/capabilities';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
import { inspectChatCapabilities } from '../application/inspect-chat-capabilities';
import { NoModelAvailableError } from '../application/resolve-model';

/**
 * Read-only inspector for the effective capability set of a chat. Accepts the
 * same model/agent selection overrides the composer sends on a turn, so the
 * projection matches what generation would actually use.
 */
export const capabilityRoutes = new Elysia()
  .use(requireAuth)

  .get(
    '/chats/:id/capabilities',
    async ({ params, query, user, set }) => {
      try {
        return await inspectChatCapabilities({
          db: getDb(),
          userId: user?.id ?? '',
          chatId: params.id,
          model: query.model,
          agentId: query.agentId,
        });
      } catch (err) {
        if (err instanceof ChatNotFoundError) {
          set.status = 404;
          return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
        }
        if (err instanceof NoModelAvailableError) {
          set.status = 503;
          return { error: err.message, code: ERROR_CODES.PROVIDER_ERROR };
        }
        throw err;
      }
    },
    {
      params: t.Object({ id: t.String() }),
      query: ChatCapabilitiesQuerySchema,
    }
  );
