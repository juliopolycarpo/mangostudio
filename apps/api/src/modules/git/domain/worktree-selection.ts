import { normalize, resolve } from 'node:path';
import type { GitWorktree } from '@mangostudio/shared/git';

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
 * findWorktree(worktrees, '/repo', '../feature/'); // the entry at /feature
 */
export function findWorktree(
  worktrees: readonly GitWorktree[],
  root: string,
  path: string
): GitWorktree | undefined {
  const target = normalizeWorktreePath(resolve(root, path));
  return worktrees.find((worktree) => normalizeWorktreePath(worktree.path) === target);
}

/** True when two paths name the same worktree once written the same way. */
export function isSameWorktreePath(left: string, right: string): boolean {
  return normalizeWorktreePath(left) === normalizeWorktreePath(right);
}

/** Collapses `.` and `..` segments, then drops trailing separators above the root. */
function normalizeWorktreePath(path: string): string {
  const normalized = normalize(path);
  if (normalized.length <= 1) return normalized;
  return normalized.replace(/[/\\]+$/, '') || normalized;
}
