// Git helpers for change-scoped runs (--staged / --changed) and workspace mapping.

import { execSync } from 'node:child_process';
import type { WorkspaceName } from './config';

/** Files staged for commit (added/copied/modified/renamed). */
export function getStagedFiles(): string[] {
  const out = execSync('git diff --name-only --cached --diff-filter=ACMR', {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

/** Files changed between baseRef and HEAD. */
export function getChangedFiles(baseRef: string): string[] {
  const out = execSync(`git diff --name-only ${baseRef}...HEAD`, { encoding: 'utf8' });
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
    else includeRoot = true;
  }
  return { workspaces: [...set], includeRoot };
}

/** Merge-base with origin/main, falling back to HEAD~1 outside a tracked branch. */
export function resolveDefaultBase(): string {
  try {
    return execSync('git merge-base HEAD origin/main', { encoding: 'utf8' }).trim();
  } catch {
    return 'HEAD~1';
  }
}
