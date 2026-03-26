/**
 * Upload route: handles file uploads using Elysia body parsing and Bun.write.
 * Includes robust file validation using magic bytes detection.
 */

import { Elysia, t } from 'elysia';
import { join, extname } from 'path';
import { mkdirSync } from 'fs';
import { fileTypeFromBuffer } from 'file-type';
import { getConfig } from '../lib/config';
import { requireAuth } from '../plugins/auth-middleware';

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
            return { error: 'Invalid file: cannot determine file type' };
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
  );
