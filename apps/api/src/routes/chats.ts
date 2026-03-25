/**
 * Chat routes: CRUD operations for chat sessions.
 */

import { Elysia, t } from 'elysia';
import { getDb } from '../db/database';
import { requireAuth } from '../plugins/auth-middleware';

export const chatRoutes = (app: Elysia) =>
  app.group('/chats', (app) =>
    app
      .use(requireAuth)
      /** List all chats for the authenticated user ordered by most recently updated. */
      .get('/', async ({ user }) => {
        const db = getDb();
        const chats = await db
          .selectFrom('chats')
          .selectAll()
          .where('userId', '=', user?.id ?? '')
          .orderBy('updatedAt', 'desc')
          .execute();
        return chats;
      })

      /** Create a new chat for the authenticated user. */
      .post(
        '/',
        async ({ body, user }) => {
          const db = getDb();
          await db
            .insertInto('chats')
            .values({
              id: body.id,
              title: body.title,
              createdAt: body.createdAt,
              updatedAt: body.updatedAt,
              model: body.model ?? null,
              userId: user?.id ?? null,
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
        async ({ params, body, user }) => {
          const db = getDb();
          const updates: Record<string, any> = {};
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
              .where('userId', '=', user?.id ?? '')
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
        async ({ params, user }) => {
          const db = getDb();
          await db
            .deleteFrom('chats')
            .where('id', '=', params.id)
            .where('userId', '=', user?.id ?? '')
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
          const db = getDb();

          // Verify chat ownership
          const chat = await db
            .selectFrom('chats')
            .select(['id', 'userId'])
            .where('id', '=', params.chatId)
            .executeTakeFirst();

          if (!chat || chat.userId !== (user?.id ?? '')) {
            set.status = 404;
            return { error: 'Chat not found' };
          }

          const limit = query.limit ? parseInt(query.limit, 10) : 50;

          let q = db
            .selectFrom('messages')
            .selectAll()
            .where('chatId', '=', params.chatId)
            .orderBy('timestamp', 'asc');

          if (query.cursor) {
            q = q.where('timestamp', '>', parseInt(query.cursor, 10));
          }

          const messages = await q.limit(limit + 1).execute();

          let nextCursor = null;
          if (messages.length > limit) {
            const nextItem = messages.pop();
            nextCursor = nextItem?.timestamp.toString();
          }

          const mappedMessages = messages.map((msg) => ({
            ...msg,
            isGenerating: msg.isGenerating === 1,
            styleParams: msg.styleParams ? JSON.parse(msg.styleParams) : undefined,
          }));

          return {
            messages: mappedMessages,
            nextCursor,
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
