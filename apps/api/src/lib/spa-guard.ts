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
  return !['/api', '/uploads', '/images', '/scalar', '/assets'].some(
    (root) => pathname === root || pathname.startsWith(`${root}/`)
  );
}
