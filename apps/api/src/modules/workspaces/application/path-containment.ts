import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { resolveWorkspacePath } from './workspace-path';

/** Guards against symlink cycles while following dangling links manually. */
const MAX_SYMLINK_HOPS = 32;

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

/** Returns the target of `path` when it is a symlink, otherwise undefined. */
function readSymlinkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
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
  let hops = 0;

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

    // realpath reports a dangling symlink as ENOENT, but writes through it still
    // land on the target, so follow it manually instead of treating it as missing.
    const target = hops < MAX_SYMLINK_HOPS ? readSymlinkTarget(probe) : undefined;
    if (target !== undefined) {
      hops += 1;
      probe = resolve(dirname(probe), target);
      continue;
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

/** Canonicalizes a containment root once so per-candidate checks can reuse it. */
export function resolveContainmentRoot(root: string): string {
  return realpathSync(resolveWorkspacePath(root));
}

/** Containment check against an already-canonical root, for hot loops. */
export function isInsideResolvedRoot(resolvedRoot: string, candidate: string): boolean {
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
