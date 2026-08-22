/**
 * A single root-level segment carrying a file extension: `/favicon.ico`,
 * `/site.webmanifest`, `/logo.svg`. Everything the frontend emits outside
 * `assets/` has this shape, because `public/` is flat.
 *
 * Deliberately anchored to one segment. A nested dotted path is ambiguous —
 * `/library/my-skill.md` is a real SPA deep link (`$resourceKey` accepts a
 * dotted key), so claiming every dotted path for the filesystem would break
 * routes that work today. At the root there is no such collision: no generated
 * route path contains a dot.
 */
const ROOT_FILE = /^\/[^/]+\.[A-Za-z0-9]+$/;

/**
 * Directory holding the content-hashed bundle output, relative to the frontend
 * root. Stated here rather than in `frontend-static.ts` because both the SPA
 * guard and the serving code have to agree on it: `/assets/…` is a *nested*
 * dotted path, so `ROOT_FILE` does not exclude it and the prefix below is the
 * only thing that makes a missing chunk 404 instead of returning the shell at
 * 200 `text/html` — which a browser reports as a MIME-type module error naming
 * the wrong cause. `apps/frontend/build.ts` is the producer that decides the
 * name; it cannot import this (cross-workspace), so a rename there has to be
 * mirrored here.
 */
export const HASHED_ASSET_DIR = 'assets';

/**
 * Path prefixes the API owns outright. Nothing under them is ever a frontend
 * file, so a request that names one can skip the filesystem entirely.
 *
 * `/assets` is deliberately *not* in this list even though `isSpaRoute` also
 * excludes it: those files do live in the frontend directory, and the disk
 * fallback resolves them per request so a dev rebuild's freshly hashed names
 * are served without a restart.
 */
const API_RESERVED_PREFIXES = ['/api', '/uploads', '/images', '/scalar'];

function hasPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

/** True when the path belongs to an API-owned prefix rather than the frontend. */
export function isApiReservedPath(pathname: string): boolean {
  return hasPrefix(pathname, API_RESERVED_PREFIXES);
}

/**
 * Returns true when the pathname should be served as the SPA index.html.
 * Used by the onError NOT_FOUND handler in index.ts and by integration tests.
 *
 * Root-level file requests are excluded so an asset that is genuinely missing
 * ends in a 404 rather than a 200 `text/html` shell. Handing an `<img>` or a
 * `<link>` an HTML document fails silently — no server error, nothing in the
 * log, and a browser-side error that names the wrong cause. A 404 is the
 * answer that can actually be debugged.
 *
 * `/index.html` is the exception: it is the shell, not an asset beside it.
 */
export function isSpaRoute(pathname: string): boolean {
  if (pathname !== '/index.html' && ROOT_FILE.test(pathname)) return false;
  return !hasPrefix(pathname, [...API_RESERVED_PREFIXES, `/${HASHED_ASSET_DIR}`]);
}
