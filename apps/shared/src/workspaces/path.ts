import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { WorkspacePathError } from '../runtime-contract/service-errors';

export { WorkspacePathError };

function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

export function resolveWorkspacePath(
  path: string,
  options?: { requireAbsolute?: boolean }
): string {
  if (path.trim().length === 0) {
    throw new WorkspacePathError('A directory path is required.');
  }

  const expandedPath = expandHome(path);
  if (options?.requireAbsolute && !isAbsolute(expandedPath)) {
    throw new WorkspacePathError('An absolute path is required.');
  }

  return resolve(expandedPath);
}
