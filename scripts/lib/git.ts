// Git helpers for change-scoped runs (--staged / --changed) and workspace mapping.

import type { WorkspaceName } from './config';

/**
 * Run a git command via Bun's native spawnSync and return stdout.
 * Args are passed as a list (no shell), so refs never need escaping.
 * Throws with stderr on a non-zero exit.
 * // Usage: const sha = git(['rev-parse', 'HEAD']).trim();
 */
function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args]);
  if (!result.success) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.toString();
}

/** Files staged for commit (added/copied/modified/renamed). */
export function getStagedFiles(): string[] {
  const out = git(['diff', '--name-only', '--cached', '--diff-filter=ACMR']);
  return out.split('\n').filter(Boolean);
}

/** Files changed between baseRef and HEAD. */
export function getChangedFiles(baseRef: string): string[] {
  const out = git(['diff', '--name-only', `${baseRef}...HEAD`]);
  return out.split('\n').filter(Boolean);
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
    else if (f.startsWith('apps/runtime/')) set.add('runtime');
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
