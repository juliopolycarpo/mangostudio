import type { AddWorktreeBody, RemoveWorktreeBody } from '@mangostudio/shared/git';

/**
 * Raised when a free-text value would reach Git's flag parser as an option.
 *
 * There is no shell anywhere on this path — `Bun.spawn` takes argv directly —
 * so quoting is not the hazard. Git's own parser is: a value that starts with
 * `-` is read as an option wherever `--` cannot precede it, which turns a
 * worktree path of `--force` into a flag the caller never asked for.
 */
export class GitWorktreeArgumentError extends Error {
  constructor(readonly value: string) {
    super(`Git worktree argument must not begin with a dash: ${value}`);
    this.name = 'GitWorktreeArgumentError';
  }
}

/**
 * Builds the argv for `git worktree add`, separately from execution so the
 * dash guard stays unit-testable.
 *
 * The two modes are different commands, not one command with a flag: creating a
 * branch is `add -b <branch> -- <path>`, and checking an existing one out is
 * `add -- <path> <branch>`. `--` ends option parsing for the positionals, and
 * the new branch name — which has to precede it, because `-b` takes its value
 * there — is guarded explicitly instead.
 *
 * @example
 * buildWorktreeAddArgs({ path: '/tmp/wt', mode: 'new-branch', branch: 'feat/x' });
 * // ['worktree', 'add', '-b', 'feat/x', '--', '/tmp/wt']
 */
export function buildWorktreeAddArgs(
  input: Pick<AddWorktreeBody, 'path' | 'mode' | 'branch'>
): string[] {
  const path = requireNonOption(input.path);
  const branch = requireNonOption(input.branch);
  if (input.mode === 'new-branch') return ['worktree', 'add', '-b', branch, '--', path];
  return ['worktree', 'add', '--', path, branch];
}

/**
 * Builds the argv for `git worktree remove`.
 *
 * A single `--force` deletes a worktree with local modifications; it still
 * refuses a locked one, which this API rejects up front rather than escalating
 * to the `-f -f` Git would need.
 *
 * @example
 * buildWorktreeRemoveArgs({ path: '/tmp/wt', force: true });
 * // ['worktree', 'remove', '--force', '--', '/tmp/wt']
 */
export function buildWorktreeRemoveArgs(
  input: Pick<RemoveWorktreeBody, 'path' | 'force'>
): string[] {
  const path = requireNonOption(input.path);
  return ['worktree', 'remove', ...(input.force ? ['--force'] : []), '--', path];
}

/**
 * Rejects a value Git would read as an option.
 *
 * `--` itself is rejected too: passed as a value it terminates option parsing
 * early and shifts every positional that follows it by one.
 */
function requireNonOption(value: string): string {
  if (value.startsWith('-')) throw new GitWorktreeArgumentError(value);
  return value;
}
