import {
  CreateMessageBodySchema,
  type GalleryPage,
  GalleryPageSchema,
  ListGalleryQuerySchema,
  UpdateMessageBodySchema,
} from '@mangostudio/shared/chat';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import { type Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { parseQueryInt } from '../../../utils/query';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
import { createMessageUseCase } from '../application/create-message';
import { listGalleryUseCase } from '../application/list-gallery';
import { updateMessageUseCase } from '../application/update-message';
import { InvalidGalleryCursorError } from '../domain/gallery-cursor';
import { MessageNotFoundError } from '../domain/message-ownership';

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
        async ({ query, user, set }): Promise<ApiErrorResponse | GalleryPage> => {
          try {
            return await listGalleryUseCase(
              {
                userId: user?.id ?? '',
                cursor: query.cursor,
                limit: query.limit ? parseQueryInt(query.limit, 50) : undefined,
              },
              getDb()
            );
          } catch (err) {
            if (err instanceof InvalidGalleryCursorError) {
              set.status = 400;
              return { error: err.message, code: ERROR_CODES.VALIDATION };
            }
            throw err;
          }
        }
      )

      /** Create a new message for a chat owned by the user. */
      .post('/', { body: CreateMessageBodySchema }, async ({ body, user, set }) => {
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
          return { success: true };
        } catch (err) {
          if (err instanceof ChatNotFoundError) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }
          throw err;
        }
      })

      /** Update a message in a chat owned by the user. */
      .put(
        '/:id',
        {
          params: t.Object({ id: t.String() }),
          body: UpdateMessageBodySchema,
        },
        async ({ params, body, user, set }) => {
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
            return { success: true };
          } catch (err) {
            if (err instanceof MessageNotFoundError) {
              set.status = 404;
              return { error: 'Message not found', code: ERROR_CODES.NOT_FOUND };
            }
            throw err;
          }
        }
      )
  );
