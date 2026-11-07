import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

import { WorkspacePathError } from '../runtime-contract/service-errors';

export { WorkspacePathError };

/** Expand a workspace home alias without simplifying any other path component.
 * // Usage: expandWorkspacePathHome('~/projects')
 */
export function expandWorkspacePathHome(path: string): string {
  if (path.trim().length === 0) {
    throw new WorkspacePathError('A directory path is required.');
  }

  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return `${homedir()}${sep}${path.slice(2)}`;
  }

  return path;
}

export function resolveWorkspacePath(
  path: string,
  options?: { requireAbsolute?: boolean }
): string {
  const expandedPath = expandWorkspacePathHome(path);
  if (options?.requireAbsolute && !isAbsolute(expandedPath)) {
    throw new WorkspacePathError('An absolute path is required.');
  }

  return resolve(expandedPath);
}
