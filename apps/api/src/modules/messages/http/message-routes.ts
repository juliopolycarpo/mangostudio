import {
  CreateMessageBodySchema,
  GalleryPageSchema,
  ListGalleryQuerySchema,
  UpdateMessageBodySchema,
} from '@mangostudio/shared/chat';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { type Elysia, status, t } from 'elysia';

import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
import { createMessageUseCase } from '../application/create-message';
import { listGalleryUseCase } from '../application/list-gallery';
import { updateMessageUseCase } from '../application/update-message';
import { InvalidGalleryCursorError } from '../domain/gallery-cursor';
import { GeneratingMessageTextEditError } from '../domain/message-generating';
import { MessageNotFoundError } from '../domain/message-ownership';

/** The `{ success: true }` acknowledgement the message write routes answer with. */
const SuccessResponseSchema = t.Object({ success: t.Literal(true) });

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
        {
          query: ListGalleryQuerySchema,
          response: {
            200: GalleryPageSchema,
            400: ApiErrorResponseSchema,
          },
        },
        async ({ query, user }) => {
          try {
            return await listGalleryUseCase(
              {
                userId: user?.id ?? '',
                cursor: query.cursor,
                limit: query.limit,
              },
              getDb()
            );
          } catch (err) {
            if (err instanceof InvalidGalleryCursorError) {
              return status(400, { error: err.message, code: ERROR_CODES.VALIDATION });
            }
            throw err;
          }
        }
      )

      /** Create a new message for a chat owned by the user. */
      .post(
        '/',
        {
          body: CreateMessageBodySchema,
          response: { 200: SuccessResponseSchema, 404: ApiErrorResponseSchema },
        },
        async ({ body, user }) => {
          try {
            await createMessageUseCase(
              {
                id: body.id,
                chatId: body.chatId,
                userId: user?.id ?? '',
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
              getDb()
            );
            return { success: true as const };
          } catch (err) {
            if (err instanceof ChatNotFoundError) {
              return status(404, { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND });
            }
            throw err;
          }
        }
      )

      /**
       * Update a message in a chat owned by the user. A `text` patch on a message that is
       * still generating answers 409 unless the patch also sets `isGenerating: false`.
       */
      .put(
        '/:id',
        {
          params: t.Object({ id: t.String() }),
          body: UpdateMessageBodySchema,
          response: {
            200: SuccessResponseSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
        },
        async ({ params, body, user }) => {
          try {
            await updateMessageUseCase(
              {
                messageId: params.id,
                userId: user?.id ?? '',
                updates: {
                  text: body.text,
                  imageUrl: body.imageUrl,
                  isGenerating: body.isGenerating,
                  generationTime: body.generationTime,
                  modelName: body.modelName,
                  styleParams: body.styleParams,
                },
              },
              getDb()
            );
            return { success: true as const };
          } catch (err) {
            if (err instanceof MessageNotFoundError) {
              return status(404, { error: 'Message not found', code: ERROR_CODES.NOT_FOUND });
            }
            if (err instanceof GeneratingMessageTextEditError) {
              return status(409, { error: err.message, code: ERROR_CODES.CONFLICT });
            }
            throw err;
          }
        }
      )
  );
