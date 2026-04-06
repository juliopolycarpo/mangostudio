/**
 * Message routes: CRUD operations for chat messages.
 * Includes a global images endpoint for the Gallery feature.
 */

import { Elysia, t } from 'elysia';
import { getDb } from '../db/database';
import { requireAuth } from '../plugins/auth-middleware';
import { verifyChatOwnership } from '../services/chat-service';
import { createMessage, serializeStyleParams, boolToInt } from '../services/message-service';
import { parseQueryInt } from '../utils/query';

export const messageRoutes = (app: Elysia) =>
  app.group('/messages', (app) =>
    app
      .use(requireAuth)
      /**
       * Get images across all chats for the global Gallery with cursor pagination.
       * Only returns images from chats owned by the authenticated user.
       */
      .get(
        '/images',
        async ({ query, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized' };
          }
          const db = getDb();
          const limit = parseQueryInt(query.limit, 50);

          let q = db
            .selectFrom('messages as ai')
            .innerJoin('chats', 'ai.chatId', 'chats.id')
            .select([
              'ai.id',
              'ai.imageUrl',
              'ai.chatId',
              'ai.timestamp',
              (eb) =>
                eb
                  .selectFrom('messages as user_msg')
                  .select('user_msg.text')
                  .whereRef('user_msg.chatId', '=', 'ai.chatId')
                  .where('user_msg.role', '=', 'user')
                  .where('user_msg.timestamp', '<=', eb.ref('ai.timestamp'))
                  .orderBy('user_msg.timestamp', 'desc')
                  .limit(1)
                  .as('prompt'),
            ])
            .where('chats.userId', '=', user.id)
            .where('ai.role', '=', 'ai')
            .where('ai.imageUrl', 'is not', null)
            .orderBy('ai.timestamp', 'desc');

          if (query.cursor) {
            q = q.where('ai.timestamp', '<', parseQueryInt(query.cursor, 0));
          }

          const rows = await q.limit(limit + 1).execute();

          let nextCursor = null;
          if (rows.length > limit) {
            const nextItem = rows.pop();
            nextCursor = nextItem?.timestamp.toString();
          }

          const galleryItems = rows
            .filter((row): row is typeof row & { imageUrl: string } => row.imageUrl !== null)
            .map((row) => ({
              id: row.id,
              imageUrl: row.imageUrl,
              prompt: row.prompt ?? 'Generated Image',
              chatId: row.chatId,
            }));

          return {
            items: galleryItems,
            nextCursor,
          };
        },
        {
          query: t.Object({
            limit: t.Optional(t.String()),
            cursor: t.Optional(t.String()),
          }),
        }
      )

      /** Create a new message for a chat owned by the user. */
      .post(
        '/',
        async ({ body, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized' };
          }

          const db = getDb();

          if (!(await verifyChatOwnership(body.chatId, user.id, db))) {
            set.status = 404;
            return { error: 'Chat not found' };
          }

          await createMessage(
            {
              id: body.id,
              chatId: body.chatId,
              role: body.role,
              text: body.text,
              imageUrl: body.imageUrl,
              referenceImage: body.referenceImage,
              timestamp: body.timestamp,
              isGenerating: body.isGenerating ?? false,
              generationTime: body.generationTime,
              modelName: body.modelName,
              styleParams: body.styleParams,
              interactionMode: body.interactionMode ?? 'image',
            },
            db
          );

          // Update the chat's updatedAt timestamp
          await db
            .updateTable('chats')
            .set({ updatedAt: body.timestamp })
            .where('id', '=', body.chatId)
            .execute();

          return { success: true };
        },
        {
          body: t.Object({
            id: t.String(),
            chatId: t.String(),
            role: t.Union([t.Literal('user'), t.Literal('ai')]),
            text: t.String(),
            imageUrl: t.Optional(t.String()),
            referenceImage: t.Optional(t.String()),
            timestamp: t.Number(),
            isGenerating: t.Optional(t.Boolean()),
            generationTime: t.Optional(t.String()),
            modelName: t.Optional(t.String()),
            styleParams: t.Optional(t.Array(t.String())),
            interactionMode: t.Optional(t.Union([t.Literal('chat'), t.Literal('image')])),
          }),
        }
      )

      /** Update a message in a chat owned by the user. */
      .put(
        '/:id',
        async ({ params, body, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized' };
          }

          const db = getDb();

          // Verify message and chat ownership
          const msg = await db
            .selectFrom('messages')
            .innerJoin('chats', 'chats.id', 'messages.chatId')
            .select(['messages.id', 'chats.userId'])
            .where('messages.id', '=', params.id)
            .executeTakeFirst();

          if (!msg || msg.userId !== user.id) {
            set.status = 404;
            return { error: 'Message not found' };
          }

          const updates: {
            text?: string;
            imageUrl?: string;
            isGenerating?: 0 | 1;
            generationTime?: string;
            modelName?: string;
            styleParams?: string | null;
          } = {};
          if (body.text !== undefined) updates.text = body.text;
          if (body.imageUrl !== undefined) updates.imageUrl = body.imageUrl;
          if (body.isGenerating !== undefined) updates.isGenerating = boolToInt(body.isGenerating);
          if (body.generationTime !== undefined) updates.generationTime = body.generationTime;
          if (body.modelName !== undefined) updates.modelName = body.modelName;
          if (body.styleParams !== undefined)
            updates.styleParams = serializeStyleParams(body.styleParams);

          if (Object.keys(updates).length > 0) {
            await db.updateTable('messages').set(updates).where('id', '=', params.id).execute();
          }

          return { success: true };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            text: t.Optional(t.String()),
            imageUrl: t.Optional(t.String()),
            isGenerating: t.Optional(t.Boolean()),
            generationTime: t.Optional(t.String()),
            modelName: t.Optional(t.String()),
            styleParams: t.Optional(t.Array(t.String())),
          }),
        }
      )
  );
