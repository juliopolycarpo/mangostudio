import { realpathSync } from 'node:fs';
import { isPathPrefix, resolvePathThroughExistingAncestor } from '../../../lib/path-containment';
import { resolveWorkspacePath } from './workspace-path';

export { isPathPrefix } from '../../../lib/path-containment';

export class WorkdirContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkdirContainmentError';
  }
}

/**
 * Resolves a path for containment checks. Existing paths are canonicalized with
 * realpath; missing leaf paths walk up to the nearest existing ancestor so
 * planned writes are checked against the intended location.
 */
export function resolvePathForContainment(inputPath: string): string {
  return resolvePathThroughExistingAncestor(resolveWorkspacePath(inputPath));
}

/** Canonicalizes a containment root once so per-candidate checks can reuse it. */
export function resolveContainmentRoot(root: string): string {
  return realpathSync(resolveWorkspacePath(root));
}

/** Containment check against an already-canonical root, for hot loops. */
function isInsideResolvedRoot(resolvedRoot: string, candidate: string): boolean {
  return isPathPrefix(resolvedRoot, resolvePathForContainment(candidate));
}

export function isInside(root: string, candidate: string): boolean {
  return isInsideResolvedRoot(resolveContainmentRoot(root), candidate);
}

export function assertInsideWorkdir(root: string, candidate: string): void {
  if (!isInside(root, candidate)) {
    throw new WorkdirContainmentError(
      `Path "${candidate}" is outside the chat working directory. Use a path inside "${root}".`
    );
  }
}
