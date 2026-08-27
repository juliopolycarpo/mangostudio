import type { WorktreePathSemantics } from './worktree-selection';

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
 * `root` and `printed` are paths on the *runtime* that ran Git, not on the
 * hub, so this takes `paths` for the same reason `findWorktree` does: a
 * Windows hub reading a WSL repository's `C:\repo\.git` through its own
 * `node:path` would treat it as relative and join it onto the hub's own
 * filesystem, giving the main worktree's mutation and a linked worktree's
 * mutation two different lock keys for one shared administrative directory.
 *
 * Every caller runs Git with `cwd` at the repository root that produced `root`,
 * so joining against it reproduces Git's own base; `paths.join` already
 * prefers an absolute `printed` over `root`, which is what covers the linked
 * worktree's case.
 *
 * An empty answer throws rather than falling back to the root: the fallback
 * would look like a working key while quietly reintroducing the per-worktree
 * split this exists to close.
 *
 * @example
 * resolveGitCommonDir('/repo', '.git', posixPaths); // '/repo/.git'
 * resolveGitCommonDir('/repo/wt', '/repo/.git', posixPaths); // '/repo/.git'
 */
export function resolveGitCommonDir(
  root: string,
  printed: string,
  paths: Pick<WorktreePathSemantics, 'join'>
): string {
  const trimmed = printed.trim();
  if (trimmed.length === 0) {
    throw new TypeError('Git reported no common directory for this repository.');
  }
  return paths.join(root, trimmed);
}
