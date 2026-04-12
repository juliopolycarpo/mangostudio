/**
 * Chat routes: CRUD operations for chat sessions.
 */

import { type Elysia, t } from 'elysia';
import { CreateChatBodySchema, UpdateChatBodySchema } from '@mangostudio/shared/chat';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { getDb } from '../db/database';
import { requireAuth } from '../plugins/auth-middleware';
import { verifyChatOwnership } from '../services/chat-service';
import { mapMessageRow } from '../services/message-service';
import { parseQueryInt } from '../utils/query';
import { parseContinuationEnvelope } from '../services/providers/continuation';
import { getContextSeverity } from '../services/providers/context-policy';
import { generateId } from '../utils/id';

/** Extract context info from a raw ContinuationEnvelope JSON string. */
function extractContextInfo(providerState: string | null | undefined): {
  estimatedInputTokens: number;
  contextLimit: number;
  estimatedUsageRatio: number;
  mode: 'stateful' | 'replay';
  severity: ReturnType<typeof getContextSeverity>;
} | null {
  if (!providerState) return null;
  const envelope = parseContinuationEnvelope(providerState);
  if (!envelope?.context) return null;
  const tokens =
    envelope.context.providerReportedInputTokens ?? envelope.context.estimatedInputTokens;
  const limit = envelope.context.contextLimit;
  if (tokens == null || limit == null) return null;
  const ratio = Math.min(tokens / limit, 1);
  return {
    estimatedInputTokens: tokens,
    contextLimit: limit,
    estimatedUsageRatio: ratio,
    mode: envelope.cursor ? ('stateful' as const) : ('replay' as const),
    severity: getContextSeverity(ratio),
  };
}

export const chatRoutes = (app: Elysia) =>
  app.group('/chats', (app) =>
    app
      .use(requireAuth)
      /** List all chats for the authenticated user ordered by most recently updated. */
      .get('/', async ({ user, set }) => {
        if (!user?.id) {
          set.status = 401;
          return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED };
        }
        const db = getDb();
        const rows = await db
          .selectFrom('chats')
          .selectAll()
          .where('userId', '=', user.id)
          .orderBy('updatedAt', 'desc')
          .execute();
        return rows.map((row) => {
          const { lastProviderState, ...chat } = row;
          return { ...chat, contextInfo: extractContextInfo(lastProviderState) };
        });
      })

      /** Create a new chat for the authenticated user. */
      .post(
        '/',
        async ({ body, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED };
          }
          const db = getDb();
          const chat = {
            id: generateId(),
            title: body.title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model: body.model ?? null,
            userId: user.id,
          };
          await db.insertInto('chats').values(chat).execute();
          return chat;
        },
        {
          body: CreateChatBodySchema,
        }
      )

      /** Update a chat owned by the authenticated user. */
      .put(
        '/:id',
        async ({ params, body, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED };
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
          body: UpdateChatBodySchema,
        }
      )

      /** Delete a chat and its messages (cascades) if owned by the user. */
      .delete(
        '/:id',
        async ({ params, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED };
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
        '/:id/messages',
        async ({ params, query, user, set }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED };
          }

          const db = getDb();

          if (!(await verifyChatOwnership(params.id, user.id, db))) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }

          const limit = parseQueryInt(query.limit, 50);

          let q = db
            .selectFrom('messages')
            .selectAll()
            .where('chatId', '=', params.id)
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
          let contextInfo: ReturnType<typeof extractContextInfo> = null;

          if (!query.cursor) {
            const lastAiRow = await db
              .selectFrom('messages')
              .select('providerState')
              .where('chatId', '=', params.id)
              .where('role', '=', 'ai')
              .where('providerState', 'is not', null)
              .orderBy('timestamp', 'desc')
              .limit(1)
              .executeTakeFirst();

            contextInfo = extractContextInfo(lastAiRow?.providerState as string | null);
          }

          return {
            messages: mappedMessages,
            nextCursor,
            contextInfo,
          };
        },
        {
          params: t.Object({ id: t.String() }),
          query: t.Object({
            limit: t.Optional(t.String()),
            cursor: t.Optional(t.String()),
          }),
        }
      )
  );
