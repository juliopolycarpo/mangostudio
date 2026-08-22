import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Lists every file under the dist directory as URL paths ('/index.html',
 * '/assets/index-abc.js'). Keys always use '/' separators regardless of the
 * host platform; sorted for deterministic module output.
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
    .sort();
}

/** The absolute path a URL path names inside distDir — the inverse of `listDistFiles`. */
export function distFilePath(distDir: string, urlPath: string): string {
  return join(distDir, ...urlPath.split('/').filter(Boolean));
}
