/**
 * `GET /uploads/*`: serves user uploads by resolving each request against the
 * uploads directory, instead of enumerating the directory at startup.
 *
 * This replaced `@elysia/static`. That plugin walks its whole assets directory
 * when it is registered, whatever `alwaysStatic` says — the flag only decides
 * whether the files it found become one route each. The walk lands right after
 * `listen`, before the first request is answered, and it grows with the upload
 * history. Worse, with `alwaysStatic` on (it defaults to
 * `NODE_ENV === 'production'`, so the compiled binary) and fewer files than its
 * route limit, no wildcard is mounted: a file uploaded after startup answered
 * 404 until the next restart.
 */

import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { Elysia, NotFound } from 'elysia';
import { fileEtag, isNotModified } from '../lib/http-cache';
import { resolveContainedPath } from '../utils/paths';

/**
 * Uploads are written once under unique names, but they are still user files
 * that can be replaced or removed on disk, so they are never `immutable`. A
 * day's freshness plus validators is what the static plugin gave them.
 */
export const UPLOADED_FILE_CACHE_CONTROL = 'public, max-age=86400';

/** An upload that exists as a regular file inside the uploads directory. */
export interface ResolvedUploadedFile {
  filePath: string;
  stats: Stats;
}

/**
 * True when every segment of `requestedPath` could be a stored upload name.
 *
 * Empty and `.`-leading segments are refused: no upload writer produces them
 * (attachment segments are sanitized, image uploads are timestamp-named), and
 * refusing them keeps dotfiles such as `.env` or `.git` unreachable. A NUL
 * truncates the path at the syscall boundary and a backslash is a separator on
 * Windows, so neither can appear inside a segment.
 */
function isServableUploadPath(requestedPath: string): boolean {
  return requestedPath
    .split('/')
    .every((segment) => segment !== '' && !segment.startsWith('.') && !/[\\\0]/.test(segment));
}

/** `realpath`, or null when the path does not resolve. */
function realpathOrNull(path: string): Promise<string | null> {
  return realpath(path).catch(() => null);
}

/**
 * Resolves the upload `requestedPath` names inside `uploadsDir`, or null when
 * it is not a regular file contained in that directory.
 *
 * `requestedPath` is the route's splat, which Elysia has already
 * percent-decoded, so it is not decoded again. The lexical check rejects
 * `..%2f` traversal; the realpath comparison rejects a symlink inside the
 * directory that resolves outside it. Both ends are resolved per request, so a
 * symlinked uploads directory works and one created after startup is found.
 *
 * @example
 * const file = await resolveUploadedFile('/data/uploads', 'Chat_abc/1710000000000/photo.png');
 * if (file) console.log(file.filePath, file.stats.size);
 */
export async function resolveUploadedFile(
  uploadsDir: string,
  requestedPath: string
): Promise<ResolvedUploadedFile | null> {
  if (!isServableUploadPath(requestedPath)) return null;
  const candidate = resolveContainedPath(uploadsDir, requestedPath);
  if (!candidate) return null;

  const [rootReal, fileReal] = await Promise.all([
    realpathOrNull(uploadsDir),
    realpathOrNull(candidate),
  ]);
  if (!rootReal || !fileReal?.startsWith(rootReal + sep)) return null;

  const stats = await stat(fileReal).catch(() => null);
  return stats?.isFile() ? { filePath: fileReal, stats } : null;
}

/**
 * The `GET /uploads/*` route over `uploadsDir`.
 *
 * Construction touches no files, so startup cost does not depend on how many
 * uploads exist. Each response carries a size/mtime `ETag`, `Last-Modified`
 * and `Cache-Control`, and a matching conditional request answers 304. A miss
 * throws `NotFound`, which the app answers exactly as it did for the plugin.
 *
 * @example
 * const app = new Elysia().use(createUploadedFileRoutes(getConfig().uploads.dir));
 */
export function createUploadedFileRoutes(uploadsDir: string) {
  return new Elysia().get('/uploads/*', async ({ params, request, set }) => {
    const file = await resolveUploadedFile(uploadsDir, params['*']);
    if (!file) throw new NotFound();

    const etag = fileEtag(file.stats);
    set.headers['cache-control'] = UPLOADED_FILE_CACHE_CONTROL;
    set.headers.etag = etag;
    set.headers['last-modified'] = file.stats.mtime.toUTCString();

    if (isNotModified(request.headers, etag, file.stats.mtimeMs)) {
      set.status = 304;
      return null;
    }
    return Bun.file(file.filePath);
  });
}
