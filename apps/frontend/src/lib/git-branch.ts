/**
 * What to call the commit a worktree is sitting on.
 *
 * A detached HEAD has no branch name, so it is shown as a short hash instead —
 * and how short is a convention, not a local choice. Three surfaces derive this
 * (the sidebar row, the hub's uncommitted list, the workspace breadcrumb) and
 * each had its own `slice(0, 7)`, so the length was owned by nobody.
 */

/** Short-hash length for a detached HEAD. */
const DETACHED_HASH_LENGTH = 7;

/**
 * The branch name, or the short hash of a detached HEAD, or null when the
 * worktree reports neither.
 *
 * Takes the two values rather than a summary because the git state arrives in
 * two shapes — `GitSummary` names it `branch`, a repo's status names it
 * `branch.name` — and they mean the same thing.
 *
 * // Usage: branchLabel(summary.branch, summary.detachedAt) // => 'main'
 */
export function branchLabel(
  branch: string | null | undefined,
  detachedAt: string | null | undefined
): string | null {
  return branch ?? detachedAt?.slice(0, DETACHED_HASH_LENGTH) ?? null;
}
