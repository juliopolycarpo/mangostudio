/**
 * Chat routes: CRUD operations for chat sessions.
 */

import { Elysia, t } from 'elysia';
import { getDb } from '../db/database';
import { requireAuth } from '../plugins/auth-middleware';
import { verifyChatOwnership } from '../services/chat-service';
import { mapMessageRow } from '../services/message-service';
import { parseQueryInt } from '../utils/query';
import { parseContinuationEnvelope } from '../services/providers/continuation';
import { getContextSeverity } from '../services/providers/context-policy';

export const chatRoutes = (app: Elysia) =>
  app.group('/chats', (app) =>
    app
      .use(requireAuth)
      /** List all chats for the authenticated user ordered by most recently updated. */
      .get('/', async ({ user, set }) => {
        if (!user?.id) {
          set.status = 401;
          return { error: 'Unauthorized' };
        }
        const db = getDb();
        const chats = await db
          .selectFrom('chats')
          .selectAll()
          .where('userId', '=', user.id)
          .orderBy('updatedAt', 'desc')
          .execute();
        return chats;
      })

      /** Create a new chat for the authenticated user. */
      .post(
        '/',
        async ({ body, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized' };
          }
          const db = getDb();
          await db
            .insertInto('chats')
            .values({
              id: body.id,
              title: body.title,
              createdAt: body.createdAt,
              updatedAt: body.updatedAt,
              model: body.model ?? null,
              userId: user.id,
            })
            .execute();
          return { success: true };
        },
        {
          body: t.Object({
            id: t.String(),
            title: t.String(),
            createdAt: t.Number(),
            updatedAt: t.Number(),
            model: t.Optional(t.String()),
          }),
        }
      )

      /** Update a chat owned by the authenticated user. */
      .put(
        '/:id',
        async ({ params, body, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized' };
          }
          const db = getDb();
          const updates: {
            title?: string;
            model?: string;
            textModel?: string;
            imageModel?: string;
            lastUsedMode?: string;
          } = {};
          if (body.title !== undefined) updates.title = body.title;
          if (body.model !== undefined) updates.model = body.model;
          if (body.textModel !== undefined) updates.textModel = body.textModel;
          if (body.imageModel !== undefined) updates.imageModel = body.imageModel;
          if (body.lastUsedMode !== undefined) updates.lastUsedMode = body.lastUsedMode;

          if (Object.keys(updates).length > 0) {
            await db
              .updateTable('chats')
              .set(updates)
              .where('id', '=', params.id)
              .where('userId', '=', user.id)
              .execute();
          }
          return { success: true };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            title: t.Optional(t.String()),
            model: t.Optional(t.String()),
            textModel: t.Optional(t.String()),
            imageModel: t.Optional(t.String()),
            lastUsedMode: t.Optional(t.String()),
          }),
        }
      )

      /** Delete a chat and its messages (cascades) if owned by the user. */
      .delete(
        '/:id',
        async ({ params, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized' };
          }
          const db = getDb();
          await db
            .deleteFrom('chats')
            .where('id', '=', params.id)
            .where('userId', '=', user.id)
            .execute();
          return { success: true };
        },
        {
          params: t.Object({ id: t.String() }),
        }
      )

      /** Get messages for a specific chat with ownership verification and cursor pagination. */
      .get(
        '/:chatId/messages',
        async ({ params, query, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized' };
          }

          const db = getDb();

          if (!(await verifyChatOwnership(params.chatId, user.id, db))) {
            set.status = 404;
            return { error: 'Chat not found' };
          }

          const limit = parseQueryInt(query.limit, 50);

          let q = db
            .selectFrom('messages')
            .selectAll()
            .where('chatId', '=', params.chatId)
            .orderBy('timestamp', 'asc');

          if (query.cursor) {
            q = q.where('timestamp', '>', parseQueryInt(query.cursor, 0));
          }

          const messages = await q.limit(limit + 1).execute();

          let nextCursor = null;
          if (messages.length > limit) {
            const nextItem = messages.pop();
            nextCursor = nextItem?.timestamp.toString();
          }

          const mappedMessages = messages.map(mapMessageRow);

          // Recover last context snapshot on initial page load (no cursor)
          let contextInfo: {
            estimatedInputTokens: number;
            contextLimit: number;
            estimatedUsageRatio: number;
            mode: string;
            severity: string;
          } | null = null;

          if (!query.cursor) {
            const lastAiRow = await db
              .selectFrom('messages')
              .select('providerState')
              .where('chatId', '=', params.chatId)
              .where('role', '=', 'ai')
              .where('providerState', 'is not', null)
              .orderBy('timestamp', 'desc')
              .limit(1)
              .executeTakeFirst();

            if (lastAiRow?.providerState) {
              const envelope = parseContinuationEnvelope(lastAiRow.providerState as string);
              if (envelope?.context) {
                const tokens =
                  envelope.context.providerReportedInputTokens ??
                  envelope.context.estimatedInputTokens;
                const limit = envelope.context.contextLimit;
                if (tokens != null && limit != null) {
                  const ratio = Math.min(tokens / limit, 1);
                  contextInfo = {
                    estimatedInputTokens: tokens,
                    contextLimit: limit,
                    estimatedUsageRatio: ratio,
                    mode: envelope.cursor ? 'stateful' : 'replay',
                    severity: getContextSeverity(ratio),
                  };
                }
              }
            }
          }

          return {
            messages: mappedMessages,
            nextCursor,
            contextInfo,
          };
        },
        {
          params: t.Object({ chatId: t.String() }),
          query: t.Object({
            limit: t.Optional(t.String()),
            cursor: t.Optional(t.String()),
          }),
        }
      )
  );
