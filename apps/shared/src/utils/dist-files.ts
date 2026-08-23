import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Build stamp `apps/frontend/build.ts` writes into `dist/`, read by the API's
 * dev-server freshness check (`dev-frontend.ts`).
 *
 * It lives inside `dist/` so the same rename that publishes a build publishes
 * its stamp — there is no window where the two disagree. That puts it in a
 * directory whose consumers otherwise copy wholesale, so it is excluded in
 * exactly three places and nowhere else has to know: `listDistFiles` below
 * (which feeds the embedded manifest and the bundle reports), the
 * `frontend-dist` tarball in `scripts/release/archive-assets.ts`, and the
 * request path in `apps/api/src/server/frontend-static.ts`. Without the first,
 * `registerEmbeddedSpa` gives a compiled binary a public GET route for a build
 * diagnostic.
 */
export const BUILD_STATE_FILE = '.build-state.json';

/** The URL path `BUILD_STATE_FILE` resolves to when served from `dist/`. */
export const BUILD_STATE_URL_PATH = `/${BUILD_STATE_FILE}`;

/**
 * Lists every *shipped* file under the dist directory as URL paths
 * ('/index.html', '/assets/index-abc.js'). Keys always use '/' separators
 * regardless of the host platform; sorted for deterministic module output.
 *
 * `BUILD_STATE_FILE` is filtered out here rather than at each call site. Every
 * consumer of this function — the embedded manifest, the bundle report, the
 * build's own file count — wants the payload, and a build diagnostic that
 * reaches the manifest becomes a route the shipped binary answers.
 *
 * `relative()` rather than slicing `distDir` off the front of each child path:
 * Bun normalizes `Dirent.parentPath`, so a caller's './frontend-dist' comes back
 * as 'frontend-dist' and a slice by the longer original string eats real
 * characters — '/index.html' became '/ndex.html', and a trailing separator ate
 * two. `relative()` resolves both sides, so any spelling of the same directory
 * yields the same URL paths.
 */
export function listDistFiles(distDir: string): string[] {
  return readdirSync(distDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const child = relative(distDir, join(entry.parentPath, entry.name));
      return `/${child.split(sep).join('/')}`;
    })
    .filter((urlPath) => urlPath !== BUILD_STATE_URL_PATH)
    .sort();
}

/** The absolute path a URL path names inside distDir — the inverse of `listDistFiles`. */
export function distFilePath(distDir: string, urlPath: string): string {
  return join(distDir, ...urlPath.split('/').filter(Boolean));
}
