import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';

import { PathAccessError } from '../runtime-contract/service-errors';
import { expandWorkspacePathHome, resolveWorkspacePath } from './path';

/** Bounds symlink traversal, including chains whose final target exists. */
const MAX_SYMLINK_HOPS = 32;

/**
 * True when an already-resolved `candidate` is `root` or a strict descendant.
 * Exact component spelling is part of resolved filesystem identity: on
 * Windows, `realpathSync` canonicalizes ordinary case-insensitive ancestors
 * while preserving distinct names below a case-sensitive directory.
 * // Usage: isPathPrefix('/workspace', '/workspace/src') === true
 */
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

function splitSegments(path: string): string[] {
  return path.split(sep).filter((segment) => segment.length > 0);
}

function splitAbsolutePath(path: string): PathParts {
  const root = parse(path).root;
  return { root, segments: splitSegments(path.slice(root.length)) };
}

/**
 * Resolve a path through its nearest existing ancestor with a bounded symlink walk.
 * POSIX applies parent steps after expanding preceding links. Windows keeps
 * its native path normalization, including drive-relative paths.
 * // Usage: resolvePathThroughExistingAncestor('/workspace/not-yet.txt')
 */
export function resolvePathThroughExistingAncestor(inputPath: string): string {
  return resolvePath(inputPath, sep === '/');
}

/**
 * Recover a destination that the old lexical atomic writer could have used.
 * Use only to identify files written before physical parent traversal.
 * // Usage: resolveLegacyLexicalWritePath('/home/me/.mango/.env')
 */
export function resolveLegacyLexicalWritePath(inputPath: string): string {
  return resolvePath(inputPath, false);
}

function resolvePath(inputPath: string, physicalParents: boolean): string {
  const absolutePath = physicalParents
    ? isAbsolute(inputPath)
      ? inputPath
      : `${process.cwd()}${sep}${inputPath}`
    : resolve(inputPath);
  const initial = splitAbsolutePath(absolutePath);
  let resolvedPath = initial.root;
  let pending = [...initial.segments];
  let hops = 0;

  while (pending.length > 0) {
    const segment = pending.shift();
    if (segment === undefined) break;
    const next = resolve(resolvedPath, segment);
    // Let the filesystem reject a parent or current-directory step through
    // a regular file before dropping that component from the resolved path.
    const candidate =
      physicalParents && (segment === '..' || segment === '.')
        ? `${resolvedPath}${sep}${segment}`
        : next;
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Removing any missing component with a parent step would make the
      // planned write reachable even though the original path cannot be opened.
      if (physicalParents && pending.includes('..')) throw error;
      return resolve(realpathSync(resolvedPath), segment, ...pending);
    }

    if (!entry.isSymbolicLink()) {
      resolvedPath = next;
      continue;
    }

    if (hops >= MAX_SYMLINK_HOPS) {
      throw new PathAccessError(`Too many symbolic links while resolving "${inputPath}".`);
    }
    hops += 1;

    const target = readlinkSync(candidate);
    if (physicalParents && !isAbsolute(target)) {
      pending = [...splitSegments(target), ...pending];
      continue;
    }
    const absoluteTarget = splitAbsolutePath(
      physicalParents ? target : resolve(dirname(candidate), target)
    );
    resolvedPath = absoluteTarget.root;
    pending = [...absoluteTarget.segments, ...pending];
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

/**
 * Canonicalize an existing root once so per-candidate checks can reuse it.
 * // Usage: const root = resolveContainmentRoot('~/workspace');
 */
export function resolveContainmentRoot(root: string): string {
  // Bun's default realpathSync normalizes parent steps on POSIX before
  // following links. Use the native operation on the original spelling.
  return sep === '/'
    ? realpathSync.native(expandWorkspacePathHome(root))
    : realpathSync(resolveWorkspacePath(root));
}

/** Containment check against an already-canonical root, for hot loops. */
function isInsideResolvedRoot(resolvedRoot: string, candidate: string): boolean {
  return isPathPrefix(resolvedRoot, resolvePathForContainment(candidate));
}

export function isInside(root: string, candidate: string): boolean {
  return isInsideResolvedRoot(resolveContainmentRoot(root), candidate);
}
