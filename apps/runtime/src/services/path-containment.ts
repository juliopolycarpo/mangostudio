import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, parse, resolve, sep } from 'node:path';
import { PathAccessError } from '../errors';
import { resolveWorkspacePath } from './workspace-path';

/** Bounds symlink traversal, including chains whose final target exists. */
const MAX_SYMLINK_HOPS = 32;

/** True when `candidate` is `root` or a strict descendant (separator-safe). */
export function isPathPrefix(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(`${root}${sep}`);
}

export class WorkdirContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkdirContainmentError';
  }
}

interface PathParts {
  readonly root: string;
  readonly segments: readonly string[];
}

function splitAbsolutePath(path: string): PathParts {
  const root = parse(path).root;
  return {
    root,
    segments: path
      .slice(root.length)
      .split(sep)
      .filter((segment) => segment.length > 0),
  };
}

/**
 * Resolves an absolute or cwd-relative path through its nearest existing
 * ancestor. Every symlink is followed explicitly so existing and dangling
 * chains share one deterministic hop cap.
 */
export function resolvePathThroughExistingAncestor(inputPath: string): string {
  const absolutePath = resolve(inputPath);
  const initial = splitAbsolutePath(absolutePath);
  let resolvedPath = initial.root;
  let pending = [...initial.segments];
  let hops = 0;

  while (pending.length > 0) {
    const segment = pending.shift();
    if (segment === undefined) break;
    const candidate = resolve(resolvedPath, segment);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return resolve(realpathSync(resolvedPath), segment, ...pending);
    }

    if (!entry.isSymbolicLink()) {
      resolvedPath = candidate;
      continue;
    }

    if (hops >= MAX_SYMLINK_HOPS) {
      throw new PathAccessError(`Too many symbolic links while resolving "${inputPath}".`);
    }
    hops += 1;

    const target = splitAbsolutePath(resolve(dirname(candidate), readlinkSync(candidate)));
    resolvedPath = target.root;
    pending = [...target.segments, ...pending];
  }

  return realpathSync(resolvedPath);
}

/**
 * Resolves a path for containment checks. Existing paths are canonicalized with
 * realpath; missing leaf paths walk up to the nearest existing ancestor so
 * planned writes are checked against the intended location.
 *
 * Deliberately lexical about `~`: candidates are checked exactly as the
 * filesystem will interpret them. Expanding here would approve `~/x` as
 * `$HOME/x` while the write landed in a directory literally named `~`. Callers
 * that accept user input expand it before asking (see the hub's
 * `resolveWorkdirRelativePath`); roots still expand via `resolveContainmentRoot`
 * because those are configured values, not paths anyone opens.
 */
export function resolvePathForContainment(inputPath: string): string {
  return resolvePathThroughExistingAncestor(inputPath);
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
