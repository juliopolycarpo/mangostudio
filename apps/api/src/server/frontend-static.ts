/**
 * Frontend static asset + SPA fallback wiring for the API server.
 * Extracted from the server entrypoint so it can be reused and tested.
 */

import { existsSync, readdirSync, type Stats, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { staticPlugin } from '@elysia/static';
import { NotFound } from 'elysia';
import type { App } from '../app';
import { matchesEtag } from '../lib/http-cache';
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

  const serveEmbeddedIndex = () => serveIndexFile(indexPath, SHELL_CACHE_CONTROL);

  app.get('/', serveEmbeddedIndex);

  for (const urlPath of Object.keys(files)) {
    if (urlPath === '/index.html') {
      app.get('/index.html', serveEmbeddedIndex);
      continue;
    }
    const filePath = files[urlPath];
    if (urlPath.startsWith(`/${HASHED_ASSET_DIR}/`)) {
      const headers = { 'Cache-Control': HASHED_CACHE_CONTROL };
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
 * The cache policy, stated once for both the embedded and the disk branch.
 *
 * Hashed `assets/` filenames carry a content hash, so a changed file is a
 * different URL and the old one can never go stale: a year, `immutable`. The
 * SPA shell is the opposite — every build renames the bundles it points at, so
 * it must revalidate on every use or a cached shell requests scripts that no
 * longer exist and renders blank.
 */
const HASHED_MAX_AGE = 31_536_000;
const HASHED_CACHE_CONTROL = `public, max-age=${HASHED_MAX_AGE}, immutable`;
const SHELL_CACHE_CONTROL = 'no-cache';

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

/**
 * `BunFile.stat()`, or null when there is nothing to stat.
 *
 * Measured on the pinned Bun 1.4.0: for a file embedded in a compiled binary
 * `stat()` returns `undefined` — not a rejected promise, not a promise at all —
 * so `file.stat().catch(…)` throws `undefined is not an object` synchronously
 * out of the handler and the binary answers 500 with Bun's own error page. A
 * missing file on disk is the other shape: `stat()` rejects with ENOENT. Both
 * have to be caught here, and neither can be told apart from the other by the
 * result alone — `exists()` is what separates "embedded, no inode" from "gone".
 */
async function statBunFile(file: Bun.BunFile): Promise<Stats | null> {
  try {
    return ((await file.stat()) as Stats | undefined) ?? null;
  } catch {
    return null;
  }
}

async function serveUnhashedFile(filePath: string, request: Request): Promise<Response> {
  // The routes below are enumerated once at boot, but the file behind one can
  // disappear afterwards: `build.ts` removes `dist/` before every rebuild, so a
  // request that lands in that window — or after a rebuild that failed and left
  // nothing — would otherwise throw ENOENT out of the handler and answer 500.
  // A file that is not there is a 404, the same answer the static plugin gave.
  const file = Bun.file(filePath);
  // No stat means one of two things, and they are not the same answer: the
  // file is gone (disk, ENOENT), or it is embedded in a compiled binary, where
  // the bytes are there and there is simply no inode behind them. `exists()`
  // is what separates them. Answering 404 for both — or letting `stat()`'s
  // undefined return throw — broke every unhashed root asset the shipped
  // binary serves, and all four are referenced by index.html. See statBunFile.
  const stats = await statBunFile(file);
  if (!stats) {
    if (!(await file.exists())) return new Response(null, { status: 404 });
    // Embedded: the content cannot change within one binary, so there is
    // nothing to revalidate against and no ETag to derive.
    return new Response(file, { headers: { 'Cache-Control': UNHASHED_CACHE_CONTROL } });
  }
  const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
  const headers = { 'Cache-Control': UNHASHED_CACHE_CONTROL, ETag: etag };
  if (matchesEtag(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(file, { headers });
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
      // index.html is served by the explicit GET / route and the SPA fallback.
      // Filtered before the stat so the hashed bulk of dist/ is never stat'ed.
      .filter((entry) => entry !== 'index.html' && !entry.startsWith(`${HASHED_ASSET_DIR}${sep}`))
      // `statFile`, not `statSync`: a dangling symlink or an entry removed
      // between the readdir and the stat would otherwise throw out of
      // `registerFrontend()` and stop the server from booting at all.
      .filter((entry) => statFile(join(frontendDir, entry))?.isFile() === true)
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
  const serveIndex = () => serveIndexFile(indexPath, SHELL_CACHE_CONTROL);
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
    // A year, not the plugin's 86400 default: these filenames carry a content
    // hash, so a changed file is a different URL and the old one can never go
    // stale. The embedded branch says `public, max-age=31536000, immutable` for
    // the same files; `immutable` is the one part not expressible here, because
    // the plugin builds the header as `${directive}, max-age=${maxAge}` from a
    // single-token `directive` and overwrites anything `headers` set. The
    // freshness lifetime is the part that matters, and it now matches.
    app.use(
      staticPlugin({ assets: assetsDir, prefix: `/${HASHED_ASSET_DIR}`, maxAge: HASHED_MAX_AGE })
    );
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
