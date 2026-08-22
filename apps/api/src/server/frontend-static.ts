/**
 * Frontend static asset + SPA fallback wiring for the API server.
 * Extracted from the server entrypoint so it can be reused and tested.
 */

import { existsSync, realpathSync, type Stats, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { staticPlugin } from '@elysia/static';
import { BUILD_STATE_URL_PATH } from '@mangostudio/shared/utils/dist-files';
import { NotFound } from 'elysia';
import type { App } from '../app';
import { fileEtag, matchesEtag } from '../lib/http-cache';
import { HASHED_ASSET_DIR, isApiReservedPath, isSpaRoute } from '../lib/spa-guard';
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
// Usage: registerFrontend(app, getSourceFrontendDir());
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

function serveIndexFile(indexPath: string, request: Request): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'text/html',
    'Cache-Control': SHELL_CACHE_CONTROL,
  };
  // `no-cache` means "revalidate before reuse", but a browser can only
  // revalidate against a validator. Without one it has nothing to put in
  // `If-None-Match`, so the server can never answer 304 and the whole shell is
  // re-downloaded on every deep link and every hard refresh — the one asset
  // requested on literally every navigation paying full price each time.
  //
  // `statFile` is sync and already used here, which keeps this off the async
  // path `serveUnhashedFile` needs. Inside a compiled binary there is no inode
  // to stat, so it returns null and the shell is simply served without a
  // validator, exactly as before — correct, because the content of an embedded
  // index.html cannot change within one binary.
  const stats = statFile(indexPath);
  if (stats) {
    const etag = fileEtag(stats);
    headers.ETag = etag;
    if (matchesEtag(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
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

  const serveEmbeddedIndex = (request: Request) => serveIndexFile(indexPath, request);

  app.get('/', ({ request }) => serveEmbeddedIndex(request));

  for (const urlPath of Object.keys(files)) {
    if (urlPath === '/index.html') {
      app.get('/index.html', ({ request }) => serveEmbeddedIndex(request));
      continue;
    }
    const filePath = files[urlPath];
    if (urlPath.startsWith(`/${HASHED_ASSET_DIR}/`)) {
      const headers = { 'Cache-Control': HASHED_CACHE_CONTROL };
      app.get(urlPath, () => new Response(Bun.file(filePath), { headers }));
      continue;
    }
    // The route's own URL path is a loop constant, so the directive it implies
    // is settled here rather than re-derived from `request.url` on every hit.
    const cacheControl = unhashedCacheControl(urlPath);
    app.get(urlPath, ({ request }) => serveUnhashedFile(filePath, cacheControl, request));
  }

  setFrontendFallback((request) => {
    if (request.method !== 'GET') return undefined;
    const { pathname } = new URL(request.url);
    return isSpaRoute(pathname) ? serveEmbeddedIndex(request) : undefined;
  });
  app.error(NotFound, ({ request }) => frontendNotFound(request));
}

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

/**
 * `/config.js` is the one unhashed file a deployer is expected to *edit*, so it
 * revalidates instead of sitting in a browser cache for a day. It carries the
 * runtime API base URL for a split deployment; a day-long cache would mean an
 * operator fixes a wrong URL and clients keep using the old one with nothing to
 * point at. It is a few hundred bytes, so revalidating costs a 304.
 */
const RUNTIME_CONFIG_PATH = '/config.js';

/** Cache directive for an unhashed file, given the URL path it was requested at. */
function unhashedCacheControl(urlPath: string): string {
  return urlPath === RUNTIME_CONFIG_PATH ? SHELL_CACHE_CONTROL : UNHASHED_CACHE_CONTROL;
}

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

async function serveUnhashedFile(
  filePath: string,
  cacheControl: string,
  request: Request
): Promise<Response> {
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
    return new Response(file, { headers: { 'Cache-Control': cacheControl } });
  }
  return serveStattedFile(filePath, stats, cacheControl, request);
}

/**
 * An unhashed file whose stat the caller already has: ETag, 304 short-circuit,
 * body. Split out so the filesystem branch can answer from `setFrontendFallback`,
 * whose contract is synchronous — it has a `statSync` result in hand from
 * `resolveUnhashedFile` and does not need to re-stat through `BunFile`.
 */
function serveStattedFile(
  filePath: string,
  stats: Stats,
  cacheControl: string,
  request: Request
): Response {
  const etag = fileEtag(stats);
  const headers = { 'Cache-Control': cacheControl, ETag: etag };
  if (matchesEtag(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(Bun.file(filePath), { headers });
}

/**
 * The absolute path of an unhashed file `pathname` names inside `frontendDir`,
 * or null when the request does not name one that exists.
 *
 * This replaced a boot-time enumeration of `dist/`. Enumerating once looked
 * safe — the names outside `assets/` are fixed (favicon, icons, manifest,
 * build-info) — but the *set* is not: a dev rebuild lands while this server is
 * running, so a file added to `public/` after boot had no route, fell through
 * to the SPA fallback, and was answered with `index.html` at 200 `text/html`.
 * Resolving per request is what `/assets/*` already does, and for the same
 * reason.
 *
 * Only the last segment's extension makes a path a candidate, and the file has
 * to exist: that keeps SPA deep links whose final segment happens to be dotted
 * (`/library/my-skill.md`) falling through to the shell as they do today.
 */
function resolveUnhashedFile(
  frontendDir: string,
  frontendRoot: string | null,
  pathname: string
): { filePath: string; stats: Stats } | null {
  if (!pathname.startsWith('/') || !/\.[A-Za-z0-9]+$/.test(pathname)) return null;
  // index.html is the shell. It is served by the explicit GET / route and by
  // the SPA fallback, with revalidation headers this path would not apply.
  if (pathname === '/index.html') return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed percent-escape is not a file name.
    return null;
  }
  // Build freshness metadata is an internal input, never a public frontend
  // asset. The embedded branch never sees it — `listDistFiles` drops it before
  // the manifest is generated — but this branch resolves against a live `dist/`,
  // where every build writes one.
  if (decoded === BUILD_STATE_URL_PATH) return null;
  // Checked *after* decoding: `new URL()` normalises literal `..` segments away
  // but leaves `%2e%2e` and `%2f` encoded, so the traversal attempt only becomes
  // visible here. A NUL truncates the path at the syscall boundary.
  const segments = decoded.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || /[\\\0]/.test(s))) return null;

  const filePath = join(frontendDir, ...segments);
  // Defence in depth behind the segment check: a symlink inside dist/ could
  // still resolve outward, and only a realpath comparison catches that.
  const real = realpathSyncSafe(filePath);
  if (!real || !frontendRoot || !real.startsWith(frontendRoot + sep)) return null;

  // `statFile`, not `statSync`: a dangling symlink or a file removed between
  // the resolve and the stat must answer 404, not throw out of the handler.
  const stats = statFile(real);
  return stats?.isFile() === true ? { filePath: real, stats } : null;
}

/** `realpathSync`, or null when the path cannot be resolved. */
function realpathSyncSafe(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
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
  // Resolved once here rather than per request: `frontendDir` does not change
  // for the life of the server, so re-resolving it on every SPA-fallback
  // request bought nothing but a repeated syscall.
  const frontendRoot = realpathSyncSafe(frontendDir);
  // Existence-checked for the same reason `serveUnhashedFile` is: `build.ts`
  // removes `dist/` before every rebuild, so a rebuild run against a live dev
  // server leaves `index.html` briefly absent — and a `Bun.file` that is not
  // there answers 500 with Bun's own error page once the body is read, on `/`
  // and on every deep link alike. A 404 is the honest answer for that window.
  const serveIndex = (request: Request): Response =>
    existsSync(indexPath)
      ? serveIndexFile(indexPath, request)
      : new Response(null, { status: 404 });
  const assetsDir = join(frontendDir, HASHED_ASSET_DIR);

  // Registered before the plugin: the static plugin may register GET / with an
  // undefined handler inside a compiled Bun binary (htmlBundle.default is
  // undefined for a generated HTML file), so this explicit route guarantees
  // that GET / always returns index.html.
  app.get('/', ({ request }) => serveIndex(request));

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
    // This fallback sits on *every* unmatched request, so an unknown endpoint
    // under an API-owned prefix arrives here too. Those can never name a file
    // in `dist/`, and rejecting them on the prefix — pure string work — keeps a
    // 404 for `/api/v1/thing.json` from costing a decode, a segment scan, a
    // `realpathSync` call and a `statSync`. `/assets` is not rejected here:
    // those files do live in `frontendDir`, and resolving them per request is
    // what serves a dev rebuild's freshly hashed names without a restart.
    if (isApiReservedPath(pathname)) return undefined;
    // Unhashed files resolve here rather than through routes pinned at boot, so
    // a `public/` file a rebuild added since boot is served instead of being
    // answered with the SPA shell. A root-level file that does not
    // exist falls past `isSpaRoute` to `frontendNotFound`, which is a 404.
    const resolved = resolveUnhashedFile(frontendDir, frontendRoot, pathname);
    if (resolved) {
      return serveStattedFile(
        resolved.filePath,
        resolved.stats,
        unhashedCacheControl(pathname),
        request
      );
    }
    return isSpaRoute(pathname) ? serveIndex(request) : undefined;
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
