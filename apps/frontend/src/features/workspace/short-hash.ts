/**
 * A commit as the panel prints it: seven characters, Git's own default
 * abbreviation and what the history list shows (`git log --oneline`). The diff
 * header, the detached-HEAD label, the worktree list and the commit toasts each
 * sliced their own length, so one commit read `7a46b99` in the list and
 * `7a46b996` in the diff opened from it.
 *
 * @example
 * shortHash('7a46b996c0ffee…') // '7a46b99'
 */
export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}
