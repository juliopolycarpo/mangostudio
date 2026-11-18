import { extname } from 'node:path';

import { Elysia, status, t } from 'elysia';

import { resolveContainedPath } from '../utils/paths';

const GENERATED_IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const MIME_BY_EXTENSION = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
} as const;

export function resolveGeneratedImagePath(imagesDir: string, requestedPath: string): string | null {
  return resolveContainedPath(imagesDir, requestedPath);
}

function getGeneratedImageContentType(filePath: string): string | undefined {
  const extension = extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[extension as keyof typeof MIME_BY_EXTENSION];
}

export function createGeneratedImageRoutes(imagesDir: string) {
  return new Elysia().get(
    '/images/*',
    // The 200 body is a file stream, so only the plain-text 404 is declared.
    { response: { 404: t.String() } },
    async ({ params, set }) => {
      const filePath = resolveGeneratedImagePath(imagesDir, params['*']);
      if (!filePath) return status(404, 'Not found');

      const file = Bun.file(filePath);
      if (!(await file.exists())) return status(404, 'Not found');

      set.headers['Cache-Control'] = GENERATED_IMAGE_CACHE_CONTROL;
      const contentType = getGeneratedImageContentType(filePath);
      if (contentType) set.headers['Content-Type'] = contentType;

      return file;
    }
  );
}
