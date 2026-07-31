import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Resolves `requestedPath` inside `root`, or null when it would escape.
 *
 * Any route that turns a stored or requested string into a file it reads needs
 * this check, and it is the kind of check that is subtly wrong when written
 * twice: comparing the resolved path with `startsWith(root)` matches a sibling
 * directory whose name merely begins with the root's, so containment is decided
 * on path segments instead.
 */
export function resolveContainedPath(root: string, requestedPath: string): string | null {
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, requestedPath);
  const relativePath = relative(rootPath, filePath);

  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
  if (relativePath.split(sep).includes('..')) return null;
  return filePath;
}
