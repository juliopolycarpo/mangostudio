// Git helpers for change-scoped runs (--staged / --changed) and workspace mapping.

import type { WorkspaceName } from './config';

/**
 * Run a git command via Bun's native spawnSync and return stdout.
 * Args are passed as a list (no shell), so refs never need escaping.
 * Throws with stderr on a non-zero exit.
 * // Usage: const sha = git(['rev-parse', 'HEAD']).trim();
 */
function git(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(['git', ...args], cwd ? { cwd } : {});
  if (!result.success) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.toString();
}

/**
 * Files staged for commit, deletions included.
 *
 * A deletion is a change like any other to everything downstream: these paths
 * only ever select workspaces and gates by pattern, and removing a file is
 * exactly as able to break its importers, or to leave a generated artifact
 * missing, as editing one. Excluding `D` made a commit whose only staged change
 * was a deletion exit as "nothing to check" — `getChangedFiles` never filtered,
 * so the same commit failed on somebody else's run instead.
 *
 * @example
 * getStagedFiles(); // ['apps/api/src/routes/chats.ts']
 */
export function getStagedFiles(cwd?: string): string[] {
  const out = git(['diff', '--name-only', '--cached', '--diff-filter=ACMRD'], cwd);
  return out.split('\n').filter(Boolean);
}

/** Files changed between baseRef and HEAD. */
export function getChangedFiles(baseRef: string): string[] {
  const out = git(['diff', '--name-only', `${baseRef}...HEAD`]);
  return out.split('\n').filter(Boolean);
}

/**
 * Files that differ between `baseRef` and the working tree: committed, staged,
 * unstaged and untracked alike, as repository-relative paths. This is the set
 * `bun test --changed=<baseRef>` selects from, so a caller planning around that
 * flag sees the same files Bun will.
 *
 * @example
 * getWorkingTreeChanges('origin/main'); // ['apps/api/src/app.ts', 'notes.md']
 */
export function getWorkingTreeChanges(baseRef: string, cwd?: string): string[] {
  const tracked = git(['diff', '--name-only', baseRef], cwd);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--full-name', ':/'], cwd);
  return [...new Set(`${tracked}\n${untracked}`.split('\n').filter(Boolean))];
}

/**
 * Every file in the checkout that Git does not ignore: tracked files plus new
 * unignored ones, as repository-relative paths. A tracked file deleted from the
 * working tree is still listed.
 *
 * @example
 * listCheckoutFiles(); // ['AGENTS.md', 'apps/api/src/app.ts', ...]
 */
export function listCheckoutFiles(cwd?: string): string[] {
  const out = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd);
  return [...new Set(out.split('\0').filter(Boolean))];
}

/**
 * The merge-base of HEAD and `ref`, as a full sha. `bun test --changed=<ref>`
 * diffs against `ref` itself, so a base branch that moved on would pull its own
 * new commits into the selection; passing the merge-base keeps it to this
 * branch's changes, the same range `getChangedFiles` reads.
 *
 * @example
 * resolveMergeBase('origin/main'); // '7d7263d6…'
 */
export function resolveMergeBase(ref: string, cwd?: string): string {
  return git(['merge-base', 'HEAD', ref], cwd).trim();
}

/** Reduce a file list to the affected workspaces and whether root files changed. */
export function mapFilesToWorkspaces(files: string[]): {
  workspaces: WorkspaceName[];
  includeRoot: boolean;
} {
  const set = new Set<WorkspaceName>();
  let includeRoot = false;
  for (const f of files) {
    if (f.startsWith('apps/frontend/')) set.add('frontend');
    else if (f.startsWith('apps/api/')) set.add('api');
    else if (f.startsWith('apps/shared/')) set.add('shared');
    else includeRoot = true;
  }
  return { workspaces: [...set], includeRoot };
}

/** Merge-base with origin/main, falling back to HEAD~1 outside a tracked branch. */
export function resolveDefaultBase(): string {
  try {
    return git(['merge-base', 'HEAD', 'origin/main']).trim();
  } catch {
    return 'HEAD~1';
  }
}
