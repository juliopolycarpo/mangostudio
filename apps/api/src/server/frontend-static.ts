/**
 * Frontend static asset + SPA fallback wiring for the API server.
 * Extracted from the server entrypoint so it can be reused and tested.
 */

import { existsSync, readdirSync, type Stats, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { staticPlugin } from '@elysia/static';
import { NotFound } from 'elysia';
import type { App } from '../app';
import { isSpaRoute } from '../lib/spa-guard';
import { type EmbeddedFrontendFiles, getEmbeddedFrontend } from './embedded-frontend';
import { frontendNotFound, setFrontendFallback } from './frontend-fallback';

/** True when a built frontend (index.html) exists in the directory. // Usage: hasFrontend(dir) */
function hasFrontend(frontendDir: string): boolean {
  try {
    return existsSync(frontendDir) && existsSync(join(frontendDir, 'index.html'));
  } catch (error) {
    console.warn('[frontend] Failed to inspect frontend directory:', error);
    return false;
  }
}

/** Register static assets + SPA fallback, or a bare 404 when no frontend exists. */
// Usage: registerFrontend(app, getDefaultFrontendDir());
export function registerFrontend(app: App, frontendDir: string): void {
  const embedded = getEmbeddedFrontend();
  if (embedded) {
    console.warn('[frontend] Serving embedded frontend assets');
    registerEmbeddedSpa(app, embedded);
    return;
  }

  if (!hasFrontend(frontendDir)) {
    console.warn(`[frontend] No frontend found at: ${frontendDir}`);
    registerApiOnly(app);
    return;
  }

  console.warn(`[frontend] Serving from: ${frontendDir}`);
  registerSpa(app, frontendDir);
}

function serveIndexFile(indexPath: string, cacheControl?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'text/html' };
  if (cacheControl) {
    headers['Cache-Control'] = cacheControl;
  }
  return new Response(Bun.file(indexPath), { headers });
}

/**
 * Serve embedded assets without a root catch-all wildcard. A root
 * `app.get('/*')` would shadow other root-level wildcard routes — most
 * notably Better Auth's mounted `/api/auth/*` handler — so this mirrors the
 * filesystem path in `registerSpa`: one explicit GET route per embedded
 * asset, plus a NOT_FOUND error handler for SPA fallback. Explicit API
 * routes and mounted plugins keep matching first; the SPA shell only lands
 * on paths nothing else claimed.
 *
 * The bundler content-hashes `/assets/*`, so those are immutable; index.html must
 * revalidate so browsers pick up new bundles after an upgrade instead of
 * serving a stale cached shell.
 */
function registerEmbeddedSpa(app: App, files: EmbeddedFrontendFiles): void {
  const indexPath = files['/index.html'];
  if (!indexPath) {
    console.warn('[frontend] Embedded frontend has no index.html; serving API only');
    registerApiOnly(app);
    return;
  }

  const serveEmbeddedIndex = () => serveIndexFile(indexPath, 'no-cache');

  app.get('/', serveEmbeddedIndex);

  for (const urlPath of Object.keys(files)) {
    if (urlPath === '/index.html') {
      app.get('/index.html', serveEmbeddedIndex);
      continue;
    }
    const filePath = files[urlPath];
    if (urlPath.startsWith('/assets/')) {
      const headers = { 'Cache-Control': 'public, max-age=31536000, immutable' };
      app.get(urlPath, () => new Response(Bun.file(filePath), { headers }));
      continue;
    }
    app.get(urlPath, ({ request }) => serveUnhashedFile(filePath, request));
  }

  setFrontendFallback((request) => {
    if (request.method !== 'GET') return undefined;
    const { pathname } = new URL(request.url);
    return isSpaRoute(pathname) ? serveEmbeddedIndex() : undefined;
  });
  app.error(NotFound, ({ request }) => frontendNotFound(request));
}

/** Directory holding the content-hashed bundle output, relative to the frontend root. */
const HASHED_ASSET_DIR = 'assets';

/**
 * Unhashed root files (favicon, icons, manifest, build-info) previously sat
 * behind `staticPlugin({ prefix: '/' })`, which served them with its defaults:
 * `Cache-Control: public, max-age=86400`, an ETag and a 304 short-circuit.
 * The per-file routes that replaced that wildcard (see `registerSpa`) keep the
 * same behavior. The ETag derives from size and mtime per request, so a dev
 * rebuild that replaces the file invalidates the cached copy.
 */
const UNHASHED_CACHE_CONTROL = 'public, max-age=86400';

/** `statSync`, or null when the entry is gone or unreadable. */
function statFile(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function serveUnhashedFile(filePath: string, request: Request): Response {
  // The routes below are enumerated once at boot, but the file behind one can
  // disappear afterwards: `build.ts` removes `dist/` before every rebuild, so a
  // request that lands in that window — or after a rebuild that failed and left
  // nothing — would otherwise throw ENOENT out of the handler and answer 500.
  // A file that is not there is a 404, the same answer the static plugin gave.
  const stats = statFile(filePath);
  if (!stats) return new Response(null, { status: 404 });
  const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
  const headers = { 'Cache-Control': UNHASHED_CACHE_CONTROL, ETag: etag };
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(Bun.file(filePath), { headers });
}

/**
 * Files the build emits outside `assets/`, as URL paths.
 *
 * Their names are fixed (favicon, icons, manifest, build-info), so enumerating
 * once at boot is safe — unlike the hashed bundle output, whose filenames change
 * on every rebuild and therefore has to stay behind a dynamic route.
 */
function unhashedAssetPaths(frontendDir: string): string[] {
  return (
    readdirSync(frontendDir, { recursive: true, encoding: 'utf8' })
      // `statFile`, not `statSync`: a dangling symlink or an entry removed
      // between the readdir and the stat would otherwise throw out of
      // `registerFrontend()` and stop the server from booting at all.
      .filter((entry) => statFile(join(frontendDir, entry))?.isFile() === true)
      // index.html is served by the explicit GET / route and the SPA fallback.
      .filter((entry) => entry !== 'index.html' && !entry.startsWith(`${HASHED_ASSET_DIR}${sep}`))
      // Recursive readdir yields platform separators; URL paths always use '/'.
      .map((entry) => entry.split(sep).join('/'))
  );
}

/**
 * Serve a built frontend from disk without a root catch-all wildcard.
 *
 * `staticPlugin({ prefix: '/' })` registers `GET /*` unless `alwaysStatic` is on
 * (it keys off `NODE_ENV === 'production'`, which nothing here sets). Once
 * `.listen()` promotes routes into Bun's native table, that root wildcard wins
 * over every `.all('/*')` route in the app — at the root, inside a `.group()`
 * and inside a mounted prefixed instance alike — while literal routes and
 * `.get('/*')` wildcards keep matching. Better Auth is mounted as `.all('/*')`
 * in `routes/auth.ts`, so sign-in, sign-up and get-session all answered 404
 * while `/api/auth/ok` worked. `app.handle()` resolves the same request
 * correctly, so nothing that drives the app in-process can see it.
 *
 * So the prefix is narrowed to `/assets`, which is where the only
 * rebuild-renamed files live, and everything else gets an explicit route. This
 * mirrors what `registerEmbeddedSpa` already does for the same reason.
 */
function registerSpa(app: App, frontendDir: string): void {
  const indexPath = join(frontendDir, 'index.html');
  const serveIndex = () => serveIndexFile(indexPath);
  const assetsDir = join(frontendDir, HASHED_ASSET_DIR);

  // Registered before the plugin: the static plugin may register GET / with an
  // undefined handler inside a compiled Bun binary (htmlBundle.default is
  // undefined for a generated HTML file), so this explicit route guarantees
  // that GET / always returns index.html.
  app.get('/', serveIndex);

  for (const urlPath of unhashedAssetPaths(frontendDir)) {
    const filePath = join(frontendDir, urlPath);
    app.get(`/${urlPath}`, ({ request }) => serveUnhashedFile(filePath, request));
  }

  if (existsSync(assetsDir)) {
    app.use(staticPlugin({ assets: assetsDir, prefix: `/${HASHED_ASSET_DIR}` }));
  }

  app.error(NotFound, ({ request }) => frontendNotFound(request));

  setFrontendFallback((request) => {
    if (request.method !== 'GET') return undefined;
    const { pathname } = new URL(request.url);
    return isSpaRoute(pathname) ? serveIndex() : undefined;
  });
}

function registerApiOnly(app: App): void {
  setFrontendFallback((request) => {
    const { pathname } = new URL(request.url);
    // The outer `NotFound` handler in `app.ts` runs first and stops when this
    // returns a body. Claiming `/api/*` here would turn unknown endpoints into
    // plaintext instead of `ApiErrorResponse`.
    if (pathname === '/api' || pathname.startsWith('/api/')) return undefined;
    return new Response('Frontend not found. API is running.', { status: 404 });
  });
  app.error(NotFound, ({ request }) => frontendNotFound(request));
}
