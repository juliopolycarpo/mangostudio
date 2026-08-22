import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Lists every file under the dist directory as URL paths ('/index.html',
 * '/assets/index-abc.js'). Keys always use '/' separators regardless of the
 * host platform; sorted for deterministic module output.
 */
export function listDistFiles(distDir: string): string[] {
  return readdirSync(distDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      const relative = absolute.slice(distDir.length).split(sep).filter(Boolean);
      return `/${relative.join('/')}`;
    })
    .sort();
}

/** The absolute path a URL path names inside distDir — the inverse of `listDistFiles`. */
export function distFilePath(distDir: string, urlPath: string): string {
  return join(distDir, ...urlPath.split('/').filter(Boolean));
}
