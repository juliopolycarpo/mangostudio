/**
 * Upload route: handles file uploads using Elysia body parsing and Bun.write.
 * Includes robust file validation using magic bytes detection.
 */

import { UploadChatAttachmentResponseSchema } from '@mangostudio/shared/chat';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { type Elysia, t } from 'elysia';
import { fileTypeFromBuffer } from 'file-type';
import { mkdirSync } from 'fs';
import { extname, join } from 'path';
import { getDb } from '../db/database';
import { getConfig } from '../lib/config';
import {
  buildAttachmentStoragePath,
  writeAttachmentFile,
} from '../modules/attachments/application/attachment-storage';
import {
  CHAT_ATTACHMENT_MAX_SIZE,
  InvalidAttachmentError,
  validateChatAttachmentFile,
} from '../modules/attachments/application/attachment-validation';
import { insertChatAttachment } from '../modules/attachments/infrastructure/attachment-repository';
import { getById } from '../modules/chats/infrastructure/chat-repository';
import { requireAuth } from '../plugins/auth-middleware';
import { generateId } from '../utils/id';

const UPLOADS_DIR = getConfig().uploads.dir;

// Ensure uploads directory exists at module load
mkdirSync(UPLOADS_DIR, { recursive: true });

export const uploadRoutes = (app: Elysia) =>
  app.group('/upload', (app) =>
    app
      .use(requireAuth)
      /** Upload a single image file. */
      .post(
        '/',
        async ({ body, set }) => {
          const file = body.image;
          const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
          const ext = extname(file.name || '.png') || '.png';
          const filename = `${uniqueSuffix}${ext}`;
          const filePath = join(UPLOADS_DIR, filename);

          const buffer = await file.arrayBuffer();

          // Validate file content using magic bytes
          const fileType = await fileTypeFromBuffer(buffer);
          if (!fileType) {
            set.status = 400;
            return {
              error: 'Invalid file: cannot determine file type',
              code: ERROR_CODES.VALIDATION,
            };
          }

          // Allow only specific image MIME types
          const allowedMimeTypes = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
            'image/avif',
            'image/heic',
            'image/heif',
          ];

          if (!allowedMimeTypes.includes(fileType.mime)) {
            set.status = 400;
            return {
              error: `Invalid file type: ${fileType.mime}. Allowed types: ${allowedMimeTypes.join(', ')}`,
              code: ERROR_CODES.VALIDATION,
            };
          }

          // Additional security: ensure file extension matches detected type
          const expectedExtensions: Record<string, string[]> = {
            'image/jpeg': ['.jpg', '.jpeg'],
            'image/png': ['.png'],
            'image/gif': ['.gif'],
            'image/webp': ['.webp'],
            'image/avif': ['.avif'],
            'image/heic': ['.heic', '.heif'],
            'image/heif': ['.heic', '.heif'],
          };

          const expectedExts = expectedExtensions[fileType.mime] || [];
          if (expectedExts.length > 0 && !expectedExts.includes(ext.toLowerCase())) {
            console.warn(
              `File extension mismatch: detected ${fileType.mime} but extension is ${ext}`
            );
            // We'll still allow it, but log a warning
          }

          await Bun.write(filePath, buffer);

          const imageUrl = `/uploads/${filename}`;
          return { imageUrl };
        },
        {
          body: t.Object({
            image: t.File({ type: 'image/*', maxSize: '20m' }),
          }),
        }
      )

      /** Upload a chat-scoped attachment file. */
      .post(
        '/chat',
        async ({ body, set, user }) => {
          const db = getDb();
          const chat = await getById(body.chatId, db);
          const userId = user?.id ?? '';

          if (!chat || chat.userId !== userId) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }

          try {
            const attachmentId = generateId();
            const uploadedAt = Date.now();
            const validatedFile = await validateChatAttachmentFile(body.file);
            const storagePath = buildAttachmentStoragePath({
              chatId: chat.id,
              chatTitle: chat.title,
              attachmentId,
              originalName: body.file.name,
              extension: validatedFile.extension,
              uploadedAt,
            });

            await writeAttachmentFile(storagePath.absolutePath, validatedFile.buffer);

            const attachment = await insertChatAttachment(
              {
                id: attachmentId,
                userId,
                chatId: chat.id,
                originalName: body.file.name,
                storedName: storagePath.storedName,
                relativePath: storagePath.relativePath,
                url: storagePath.url,
                mimeType: validatedFile.mimeType,
                sizeBytes: validatedFile.sizeBytes,
                kind: validatedFile.kind,
                createdAt: uploadedAt,
              },
              db
            );

            return { attachment };
          } catch (err) {
            if (err instanceof InvalidAttachmentError) {
              set.status = 400;
              return { error: err.message, code: ERROR_CODES.VALIDATION };
            }
            throw err;
          }
        },
        {
          body: t.Object({
            chatId: t.String(),
            file: t.File({ maxSize: CHAT_ATTACHMENT_MAX_SIZE }),
          }),
          response: {
            200: UploadChatAttachmentResponseSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
          },
        }
      )
  );
