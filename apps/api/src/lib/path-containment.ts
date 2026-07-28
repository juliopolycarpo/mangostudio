import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, parse, resolve, sep } from 'node:path';

/** Bounds symlink traversal, including chains whose final target exists. */
const MAX_SYMLINK_HOPS = 32;

/** True when `candidate` is `root` or a strict descendant (separator-safe). */
export function isPathPrefix(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(`${root}${sep}`);
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

function tooManySymlinksError(inputPath: string): NodeJS.ErrnoException {
  const error = new Error(
    `ELOOP: too many symbolic links encountered, realpath '${inputPath}'`
  ) as NodeJS.ErrnoException;
  error.code = 'ELOOP';
  error.path = inputPath;
  error.syscall = 'realpath';
  return error;
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

    if (hops >= MAX_SYMLINK_HOPS) throw tooManySymlinksError(inputPath);
    hops += 1;

    const target = splitAbsolutePath(resolve(dirname(candidate), readlinkSync(candidate)));
    resolvedPath = target.root;
    pending = [...target.segments, ...pending];
  }

  return realpathSync(resolvedPath);
}
