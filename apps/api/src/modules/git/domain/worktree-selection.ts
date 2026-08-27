import type { GitWorktree } from '@mangostudio/shared/git';

/**
 * The two path operations this comparison needs, performed the way the machine
 * that owns the repository would perform them.
 *
 * Taken as a parameter rather than imported from `node:path`, because every
 * path here belongs to the *runtime* and not to the hub: a Windows hub driving
 * a WSL distro would read `/home/u/wt` through `win32`, and `win32.resolve`
 * would additionally prefix the hub's own drive — so the caller's path and the
 * listed path would normalize to two different strings and no worktree would
 * ever match. `TargetPaths` (`services/runtime-client/target-paths.ts`)
 * satisfies this shape and is what the service passes; the structural type
 * keeps this module free of the transport layer.
 */
export interface WorktreePathSemantics {
  /** Canonical form of an absolute path: `.`, `..` and trailing separators removed. */
  canonical(path: string): string;
  /**
   * True when two paths name the same location under the target's own rules —
   * case-folded on `win32`, where `git worktree list` and a caller's own root
   * can disagree in casing and still name one directory.
   */
  equals(left: string, right: string): boolean;
  /** Joins a relative path onto an absolute base; an absolute path wins over the base. */
  join(base: string, path: string): string;
}

/**
 * Finds the listed worktree a caller's path refers to, or `undefined`.
 *
 * Git prints canonical absolute paths, and a caller types whatever reads well —
 * a trailing slash, a `.` segment, or a path relative to the repository root
 * (which is what Git itself would resolve against, since every command here
 * runs with `cwd` at that root). Matching lexically rather than through
 * `realpath` is deliberate: the repository may live on a runtime host, so the
 * hub's filesystem has no say in what these paths mean.
 *
 * The match is exact after normalization rather than by suffix. `git worktree
 * remove` accepts an unambiguous suffix, but a caller who names a worktree
 * imprecisely should get a refusal, not a different worktree deleted.
 *
 * @example
 * findWorktree(worktrees, '/repo', '../feature/', runtime.paths); // the entry at /feature
 */
export function findWorktree(
  worktrees: readonly GitWorktree[],
  root: string,
  path: string,
  paths: WorktreePathSemantics
): GitWorktree | undefined {
  const target = paths.join(root, path);
  return worktrees.find((worktree) => paths.equals(worktree.path, target));
}

/** True when two paths name the same worktree once written the same way. */
export function isSameWorktreePath(
  left: string,
  right: string,
  paths: WorktreePathSemantics
): boolean {
  return paths.equals(left, right);
}
