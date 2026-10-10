/**
 * Frontend static asset + SPA fallback wiring for the API server.
 * Extracted from the server entrypoint so it can be reused and tested.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { BUILD_STATE_FILE, BUILD_STATE_URL_PATH } from '@mangostudio/shared/utils/dist-files';
import { NotFound } from 'elysia';
import type { App } from '../app';
import { contentEtag, fileEtag, matchesEtag } from '../lib/http-cache';
import { HASHED_ASSET_DIR, isApiOwnedPath, isSpaRoute } from '../lib/spa-guard';
import { negotiateEncoding, varyOnAcceptEncoding } from './accept-encoding';
import {
  type EmbeddedContentCoding,
  type EmbeddedFrontendEncodings,
  type EmbeddedFrontendFiles,
  getEmbeddedFrontend,
  getEmbeddedFrontendEncodings,
} from './embedded-frontend';
import {
  type FallbackResponseHeaders,
  frontendNotFound,
  setFrontendFallback,
} from './frontend-fallback';

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
    registerEmbeddedSpa(app, embedded, getEmbeddedFrontendEncodings());
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

/**
 * `no-cache` means "revalidate before reuse", but a browser can only
 * revalidate against a validator. Without one it has nothing to put in
 * `If-None-Match`, so the server can never answer 304 and the whole shell is
 * re-downloaded on every deep link and every hard refresh — the one asset
 * requested on literally every navigation paying full price each time.
 *
 * The caller supplies the validator because the right one depends on where the
 * shell lives. On disk it is `fileEtag` of a fresh stat, so a dev rebuild's
 * new mtime invalidates cached copies. Embedded in a compiled binary it must
 * be `contentEtag`: `statSync` *succeeds* on the embedded virtual path but
 * reports `mtimeMs: 0`, and index.html's byte size is constant across builds
 * (hashed asset names are fixed-length), so a stat-derived tag is the same
 * string in every release — an upgraded binary would answer 304 to the old
 * build's shell and returning users would keep the previous frontend until a
 * hard refresh. Null means "no validator": always serve fresh, never a wrong 304.
 */
function serveIndexFile(indexPath: string, etag: string | null, request: Request): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'text/html',
    'Cache-Control': SHELL_CACHE_CONTROL,
  };
  if (etag) {
    headers.ETag = etag;
    if (matchesEtag(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
  }
  return new Response(Bun.file(indexPath), { headers });
}

/**
 * An embedded file's validator: a hash of its bytes. The content cannot change
 * within one binary, so a result is good for the life of the process — and the
 * bytes are the only identity that survives embedding (see serveIndexFile).
 */
function embeddedEtag(filePath: string): string | null {
  // Degrading to no validator is safe — a full download on every navigation,
  // never a wrong 304 — but it is invisible unless said out loud: `readFileSync`
  // works on embedded virtual paths, so this firing means something unexplained.
  try {
    return contentEtag(readFileSync(filePath));
  } catch (error) {
    console.warn(`[frontend] Cannot derive a validator for embedded ${filePath}:`, error);
    return null;
  }
}

/**
 * One embedded URL and every representation of it: the identity bytes plus any
 * precompressed copies. Built once at boot, so a request does no lookup beyond
 * the map hit.
 */
interface EmbeddedAsset {
  identityPath: string;
  encodings: Readonly<Partial<Record<EmbeddedContentCoding, string>>>;
  cacheControl: string;
  /** Set explicitly when the file loader's guess is not enough: the shell, and every variant. */
  contentType: string | null;
  /** Whether representations carry a validator. Hashed assets without variants do not. */
  validated: boolean;
  /** Validators already spelled, per coding (`identity` included). */
  etags: Map<string, string | null>;
}

function createEmbeddedAsset(
  urlPath: string,
  identityPath: string,
  encodings: EmbeddedFrontendEncodings
): EmbeddedAsset {
  const variants = encodings[urlPath] ?? {};
  const hashed = urlPath.startsWith(`/${HASHED_ASSET_DIR}/`);
  const hasVariants = Object.keys(variants).length > 0;
  const isShell = urlPath === '/index.html';
  return {
    identityPath,
    encodings: variants,
    cacheControl: embeddedCacheControl(urlPath),
    // A variant's own path ends in `.br` or `.gz`, which the file loader maps to
    // an opaque type, so the identity file's type is what every representation
    // of an asset with variants must advertise.
    contentType: isShell ? 'text/html' : hasVariants ? Bun.file(identityPath).type : null,
    // `immutable` hashed files never revalidate, so a validator is dead weight
    // there — unless a second representation exists, where a validator that
    // tells the two apart is what keeps a stored copy of one from being
    // mistaken for the other.
    validated: !hashed || hasVariants,
    etags: new Map(),
  };
}

/** The strong validator of one representation, spelled on first use and then remembered. */
function representationEtag(
  asset: EmbeddedAsset,
  coding: EmbeddedContentCoding | 'identity'
): string | null {
  if (!asset.validated) return null;
  const known = asset.etags.get(coding);
  if (known !== undefined) return known;
  const path = coding === 'identity' ? asset.identityPath : asset.encodings[coding];
  const etag = path ? embeddedEtag(path) : null;
  asset.etags.set(coding, etag);
  return etag;
}

/**
 * Answer a GET or HEAD for an embedded asset with the representation the client
 * asked for.
 *
 * Only an asset that has precompressed copies negotiates: it always says
 * `Vary: Accept-Encoding`, whatever it ends up sending. A client that refuses
 * every representation still gets identity, as it did before copies existed.
 * Every other asset — fonts, images, files
 * too small to be worth compressing — is served exactly as before, because
 * nothing about its response depends on the request header.
 *
 * Each representation has its own length and its own strong ETag, so a cache
 * revalidating one can never be told another is unchanged. Range is not handled
 * here: Bun answers it over the stored bytes, which makes it a range of the
 * selected representation. Bun also ignores `If-Range`, for identity files just
 * the same, so a client resuming against a different representation than the one
 * it validated is not protected by the ETag here.
 */
function serveEmbeddedAsset(
  asset: EmbeddedAsset,
  request: Request,
  set?: FallbackResponseHeaders
): Response {
  const offered = Object.keys(asset.encodings) as EmbeddedContentCoding[];
  const negotiated = offered.length > 0;
  const choice = negotiated
    ? negotiateEncoding(request.headers.get('accept-encoding'), offered)
    : 'identity';

  const headers: Record<string, string> = { 'Cache-Control': asset.cacheControl };
  if (negotiated) {
    // Folded into the accumulated headers when Elysia hands them over, so CORS's
    // `Vary: Origin` survives; a bare `Response` header would replace it.
    if (set) varyOnAcceptEncoding(set.headers);
    else headers.Vary = 'Accept-Encoding';
  }
  if (asset.contentType) headers['Content-Type'] = asset.contentType;
  if (choice !== 'identity') headers['Content-Encoding'] = choice;

  const etag = representationEtag(asset, choice);
  if (etag) {
    headers.ETag = etag;
    if (matchesEtag(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
  }
  const filePath = choice === 'identity' ? asset.identityPath : asset.encodings[choice];
  return new Response(Bun.file(filePath as string), { headers });
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
 *
 * HEAD never matches a literal GET route, so it arrives in the fallback below,
 * which answers it for embedded assets and the SPA shell only — API and upload
 * paths decline there exactly as for any other method.
 */
function registerEmbeddedSpa(
  app: App,
  files: EmbeddedFrontendFiles,
  encodings: EmbeddedFrontendEncodings
): void {
  const assets = new Map<string, EmbeddedAsset>();
  for (const [urlPath, filePath] of Object.entries(files)) {
    assets.set(urlPath, createEmbeddedAsset(urlPath, filePath, encodings));
  }
  const shell = assets.get('/index.html');
  if (!shell) {
    console.warn('[frontend] Embedded frontend has no index.html; serving API only');
    registerApiOnly(app);
    return;
  }

  app.get('/', ({ request, set }) => serveEmbeddedAsset(shell, request, set));
  for (const [urlPath, asset] of assets) {
    app.get(urlPath, ({ request, set }) => serveEmbeddedAsset(asset, request, set));
  }

  setFrontendFallback((request, set) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
    const { pathname } = new URL(request.url);
    // The literal routes are exact manifest keys and Elysia does not normalise
    // percent escapes before matching them, so `/favicon%2eico` never reaches
    // `/favicon.ico`'s route and arrives here instead. `isSpaRoute` *does*
    // decode, recognises a root file and declines — a 404 for a file the same
    // build serves fine from disk, where `resolveFrontendFile` decodes first.
    // The shipped binary is this branch, so the decode has to happen here too.
    // An exact key lookup is the whole guard: a decoded traversal, backslash
    // or NUL form is simply not a manifest key and falls through below.
    const asset = assets.get(pathname) ?? assets.get(decodedManifestKey(pathname) ?? '');
    if (asset) return serveEmbeddedAsset(asset, request, set);
    return isSpaRoute(pathname) ? serveEmbeddedAsset(shell, request, set) : undefined;
  });
  app.error(NotFound, ({ request, set }) => frontendNotFound(request, set));
}

/**
 * The decoded form of a pathname that could still name an embedded asset, or
 * null when there is nothing left to try.
 *
 * A pathname that decodes to itself was already looked up literally, so
 * re-checking the manifest for it would find nothing.
 */
function decodedManifestKey(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed percent-escape is not a file name.
    return null;
  }
  return decoded === pathname ? null : decoded;
}

/** Cache directive for an embedded asset, given the manifest key it lives at. */
function embeddedCacheControl(urlPath: string): string {
  return urlPath === '/index.html' ? SHELL_CACHE_CONTROL : assetCacheControl(urlPath);
}

/** Cache directive for any file but the shell, hashed or not, on either branch. */
function assetCacheControl(urlPath: string): string {
  return urlPath.startsWith(`/${HASHED_ASSET_DIR}/`)
    ? HASHED_CACHE_CONTROL
    : unhashedCacheControl(urlPath);
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
 * Unhashed root files (favicon, icons, manifest, build-info) retain a day-long
 * cache with ETag revalidation. The ETag derives from size and mtime per request,
 * so a dev rebuild that replaces the file invalidates the cached copy.
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

/** File metadata for numeric cache validators and lossless filesystem identity. */
interface FrontendFileStats {
  size: number;
  mtimeMs: number;
  dev: bigint;
  ino: bigint;
}

/** A regular file's stat, or null when the entry is gone, unreadable or not a file. */
function statFile(path: string): FrontendFileStats | null {
  try {
    // NTFS file IDs can exceed Number.MAX_SAFE_INTEGER: two different inodes
    // can round to the same number and make a public asset look like metadata.
    const stats = statSync(path, { bigint: true });
    if (!stats.isFile()) return null;
    return {
      size: Number(stats.size),
      mtimeMs: Number(stats.mtimeMs),
      dev: stats.dev,
      ino: stats.ino,
    };
  } catch {
    return null;
  }
}

/**
 * A disk file whose stat the caller already has: ETag, 304
 * short-circuit, body. The filesystem branch answers with this from
 * `setFrontendFallback`, holding a `statSync` result from `resolveFrontendFile`;
 * the stat both proves the file exists — `build.ts` publishes `dist/` by
 * rename, so there is a window with nothing at the path, and a miss must be a
 * 404 rather than an ENOENT thrown out of the handler — and spells the
 * validator, so a dev rebuild's new mtime invalidates cached copies.
 */
function serveStattedFile(
  filePath: string,
  stats: FrontendFileStats,
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
 * The absolute path of a file `pathname` names inside `frontendDir`,
 * or null when the request does not name one that exists.
 *
 * Resolving per request keeps both newly hashed bundles and public files
 * available after a dev rebuild without registering a catch-all GET route.
 *
 * Only the last segment's extension makes a path a candidate, and the file has
 * to exist: that keeps SPA deep links whose final segment happens to be dotted
 * (`/library/my-skill.md`) falling through to the shell as they do today.
 */
function resolveFrontendFile(
  frontendDir: string,
  pathname: string
): { filePath: string; stats: FrontendFileStats; urlPath: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed percent-escape is not a file name.
    return null;
  }
  if (!decoded.startsWith('/') || !/\.[A-Za-z0-9]+$/.test(decoded)) return null;
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

  // Deployers can switch a frontend directory link to a new release at runtime.
  // Resolve it for each file and use that same root for all eligibility checks.
  const frontendRoot = realpathSyncSafe(frontendDir);
  if (!frontendRoot) return null;
  const filePath = join(frontendRoot, ...segments);
  // Defence in depth behind the segment check: a symlink inside dist/ could
  // still resolve outward, and only a realpath comparison catches that.
  const real = realpathSyncSafe(filePath);
  if (!real?.startsWith(frontendRoot + sep)) return null;
  // A symlink can give private build metadata a public-looking asset name.
  if (real === join(frontendRoot, BUILD_STATE_FILE)) return null;

  // `statFile`, not `statSync`: a dangling symlink or a file removed between
  // the resolve and the stat must answer 404, not throw out of the handler.
  const stats = statFile(real);
  if (!stats) return null;
  // Hardlinks have different realpaths but share file identity with the private
  // metadata. Check per request because a rebuild can replace that metadata.
  const buildStateStats = statFile(join(frontendRoot, BUILD_STATE_FILE));
  if (buildStateStats && stats.dev === buildStateStats.dev && stats.ino === buildStateStats.ino) {
    return null;
  }
  return { filePath: real, stats, urlPath: decoded };
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
 * Bun's native routing table promotes a root GET wildcard ahead of mounted
 * `.all('/*')` handlers, including Better Auth. Keep only the literal shell
 * route and serve files through the existing NotFound fallback instead.
 */
function registerSpa(app: App, frontendDir: string): void {
  // The shell follows the same eligibility checks as every other disk file.
  // Missing files during a rebuild and ineligible links both answer 404.
  const serveIndex = (request: Request): Response => {
    const resolved = resolveFrontendFile(frontendDir, '/index.html');
    return resolved
      ? serveIndexFile(resolved.filePath, fileEtag(resolved.stats), request)
      : new Response(null, { status: 404 });
  };
  app.get('/', ({ request }) => serveIndex(request));

  app.error(NotFound, ({ request }) => frontendNotFound(request));

  setFrontendFallback((request) => {
    if (request.method !== 'GET') return undefined;
    const { pathname } = new URL(request.url);
    // This fallback sits on *every* unmatched request, so an unknown endpoint
    // under an API-owned prefix arrives here too. Those can never name a file
    // in `dist/`, and rejecting them here keeps a 404 for `/api/v1/thing.json`
    // from costing a `realpathSync` call and a `statSync`. `/assets` is not
    // rejected: those files do live in `frontendDir`, and resolving them per
    // request is what serves a dev rebuild's freshly hashed names without a
    // restart.
    if (isApiOwnedPath(pathname)) return undefined;
    // Files resolve here rather than through routes pinned at boot. A missing
    // asset or root file falls past `isSpaRoute` to a 404 instead of the shell.
    const resolved = resolveFrontendFile(frontendDir, pathname);
    if (resolved) {
      if (resolved.urlPath === '/index.html') {
        return serveIndexFile(resolved.filePath, fileEtag(resolved.stats), request);
      }
      return serveStattedFile(
        resolved.filePath,
        resolved.stats,
        assetCacheControl(resolved.urlPath),
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
    // returns a body. Claiming an API-owned path here would turn unknown
    // endpoints into plaintext instead of `ApiErrorResponse` — which is also
    // why an undecodable pathname counts as owned rather than falling through.
    if (isApiOwnedPath(pathname)) return undefined;
    return new Response('Frontend not found. API is running.', { status: 404 });
  });
  app.error(NotFound, ({ request }) => frontendNotFound(request));
}
