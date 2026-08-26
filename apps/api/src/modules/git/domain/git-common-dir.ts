import { isAbsolute, resolve } from 'node:path';

/**
 * Resolves what `git rev-parse --git-common-dir` printed into the absolute path
 * two worktrees of one repository agree on.
 *
 * Git answers relative to its own working directory, which is why this needs
 * the root: run from the main worktree it prints `.git`, and run from a linked
 * worktree it prints the main repository's absolute `.git`. Left unresolved,
 * those two answers are different strings for one repository — and a mutation
 * lock keyed on them would not serialize a `worktree add` issued from the main
 * worktree against one issued from a linked worktree, which is precisely the
 * pair that shares the administrative state being mutated.
 *
 * Every caller runs Git with `cwd` at the repository root that produced `root`,
 * so resolving against it reproduces Git's own base.
 *
 * An empty answer throws rather than falling back to the root: the fallback
 * would look like a working key while quietly reintroducing the per-worktree
 * split this exists to close.
 *
 * @example
 * resolveGitCommonDir('/repo', '.git'); // '/repo/.git'
 * resolveGitCommonDir('/repo/wt', '/repo/.git'); // '/repo/.git'
 */
export function resolveGitCommonDir(root: string, printed: string): string {
  const trimmed = printed.trim();
  if (trimmed.length === 0) {
    throw new TypeError('Git reported no common directory for this repository.');
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
}
