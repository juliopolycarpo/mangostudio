import type { GitWorktree } from '@mangostudio/shared/git';

import type { ParsedWorktree } from './worktree-parser';

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
  /** True when `candidate` is `root` or a path below it. Both must be canonical. */
  contains(root: string, candidate: string): boolean;
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

/**
 * Every way one directory can be named: the string it was written with, and
 * where the runtime's filesystem says it really is (symlinks followed, casing
 * as stored). The second is absent for a directory that does not exist.
 *
 * Lexical rules alone cannot tell that `/home/me/wt` and `/data/wt` are one
 * directory when `/home/me` is a symlink, or that `Feature` and `feature` are
 * one on a case-insensitive volume. Only the machine that owns the directory
 * knows, so the caller asks it and hands both answers over.
 */
export type PathSpellings = readonly string[];

/**
 * True when a chat's workdir is the worktree itself or a directory inside it,
 * under any pairing of their spellings.
 *
 * A chat can be bound to a package directory of a worktree rather than its
 * root, and the stored string is whatever the user picked — a trailing
 * separator, a `.` segment — so every spelling is canonicalized first and the
 * boundary is a whole path segment: `/work/feature-2` is not inside
 * `/work/feature`.
 *
 * @example
 * isWithinWorktree(['/work/feature/packages/ui'], ['/work/feature'], paths); // true
 */
export function isWithinWorktree(
  workdir: PathSpellings,
  worktree: PathSpellings,
  paths: WorktreePathSemantics
): boolean {
  return worktree.some((root) =>
    workdir.some((candidate) => paths.contains(paths.canonical(root), paths.canonical(candidate)))
  );
}

/**
 * True when two directories are the same one, under any pairing of their
 * spellings: the strings as written, or where the runtime says each really is.
 *
 * The exact-match counterpart of {@link isWithinWorktree}. Equality goes
 * through the target's path rules, so `C:\Repo` and `c:\repo` match on a
 * case-folding volume and not elsewhere.
 *
 * @example
 * isSameDirectory(['/home/me/wt', '/data/wt'], ['/data/wt'], paths); // true
 */
export function isSameDirectory(
  left: PathSpellings,
  right: PathSpellings,
  paths: WorktreePathSemantics
): boolean {
  return left.some((candidate) => right.some((other) => paths.equals(candidate, other)));
}

/** True when two paths name the same worktree once written the same way. */
export function isSameWorktreePath(
  left: string,
  right: string,
  paths: WorktreePathSemantics
): boolean {
  return paths.equals(left, right);
}

/**
 * Stamps `isCurrent` on the listed worktree the calling chat's repository root
 * names, comparing through the target's path rules rather than string equality.
 *
 * `git rev-parse --show-toplevel` (the root) and `git worktree list` can spell
 * one directory differently — a trailing separator, or casing on Windows — and
 * the removal guard refuses on this flag rather than comparing them again, so
 * the list and the refusal cannot answer differently.
 *
 * @example
 * markCurrentWorktree(parsed, '/work/feature/', paths); // /work/feature gets isCurrent: true
 */
export function markCurrentWorktree(
  worktrees: readonly ParsedWorktree[],
  root: string,
  paths: WorktreePathSemantics
): CurrentMarkedWorktree[] {
  return worktrees.map((worktree) => ({
    ...worktree,
    isCurrent: isSameWorktreePath(worktree.path, root, paths),
  }));
}

/** A worktree once `isCurrent` is known and `boundByOtherChat` is not. */
export type CurrentMarkedWorktree = ParsedWorktree & Pick<GitWorktree, 'isCurrent'>;

/**
 * Stamps `boundByOtherChat` on every worktree that another chat's workdir is at
 * or below.
 *
 * The one place this question is answered: the list reports the flag and the
 * removal guard refuses on it, so a row the panel offers to delete is a row the
 * server will not turn down for this reason. `spellingsOf` supplies the
 * spellings of a listed worktree and `others` those of each other chat's
 * workdir; resolving them is the caller's job, as it takes the runtime.
 *
 * @example
 * markBoundByOtherChat(marked, (path) => [path], [['/work/feature/pkg']], paths);
 */
export function markBoundByOtherChat(
  worktrees: readonly CurrentMarkedWorktree[],
  spellingsOf: (worktreePath: string) => PathSpellings,
  others: readonly PathSpellings[],
  paths: WorktreePathSemantics
): GitWorktree[] {
  return worktrees.map((worktree) => {
    const spellings = spellingsOf(worktree.path);
    return {
      ...worktree,
      boundByOtherChat: others.some((workdir) => isWithinWorktree(workdir, spellings, paths)),
    };
  });
}
