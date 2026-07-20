import { realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { resolveWorkspacePath } from './workspace-path';

export class WorkdirContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkdirContainmentError';
  }
}

/** True when `candidate` is `root` or a strict descendant (separator-safe). */
export function isPathPrefix(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(`${root}${sep}`);
}

/**
 * Resolves a path for containment checks. Existing paths are canonicalized with
 * realpath; missing leaf paths walk up to the nearest existing ancestor so
 * planned writes are checked against the intended location.
 */
export function resolvePathForContainment(inputPath: string): string {
  const resolved = resolveWorkspacePath(inputPath);
  let probe = resolved;
  const pending: string[] = [];

  while (true) {
    try {
      const real = realpathSync(probe);
      return pending.length === 0 ? real : resolve(real, ...pending);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT') {
        throw error;
      }
    }

    const name = basename(probe);
    const parent = dirname(probe);
    if (parent === probe) {
      return resolved;
    }
    pending.unshift(name);
    probe = parent;
  }
}

export function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = realpathSync(resolveWorkspacePath(root));
  const resolvedCandidate = resolvePathForContainment(candidate);
  return isPathPrefix(resolvedRoot, resolvedCandidate);
}

export function assertInsideWorkdir(root: string, candidate: string): void {
  if (!isInside(root, candidate)) {
    throw new WorkdirContainmentError(
      `Path "${candidate}" is outside the chat working directory. Use a path inside "${root}".`
    );
  }
}
