// Dependency footprint parsed from bun.lock: workspace manifests, direct
// (dev)dependencies, and total locked packages.

import { join } from 'node:path';
import { ROOT_DIR } from '../../lib/config';
import type { DependencyStats } from './types';

// PR QA gate snapshots the base lockfile here so dependency deltas are measured
// against the base, not the overlaid head graph. Falls back to the live lock.
const DEPENDENCY_LOCK_SNAPSHOT = join(ROOT_DIR, '.qa-gate/base-bun.lock');

const countWorkspaceDependencyEntries = (
  lockText: string,
  sectionName: 'dependencies' | 'devDependencies'
): number => {
  const workspacesText = lockText.split('\n  "packages": {')[0] ?? lockText;
  const sectionStart = new RegExp(`^\\s{6}"${sectionName}": \\{$`);
  let count = 0;
  let inSection = false;

  for (const line of workspacesText.split('\n')) {
    if (sectionStart.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^\s{6}},?$/.test(line)) {
      inSection = false;
      continue;
    }
    if (inSection && /^\s{8}"[^"]+":/.test(line)) count++;
  }

  return count;
};

/** Parse dependency counts from the base lock snapshot (or live bun.lock). */
export const collectDependencyStats = async (): Promise<DependencyStats> => {
  const lockPath = (await Bun.file(DEPENDENCY_LOCK_SNAPSHOT).exists())
    ? DEPENDENCY_LOCK_SNAPSHOT
    : join(ROOT_DIR, 'bun.lock');
  const lockText = await Bun.file(lockPath).text();
  const workspacesText = lockText.split('\n  "packages": {')[0] ?? lockText;
  const packagesText = lockText.split('\n  "packages": {')[1] ?? '';

  return {
    workspaceManifests: (workspacesText.match(/^\s{4}"[^"]+": \{$/gm) ?? []).length,
    directDependencies: countWorkspaceDependencyEntries(lockText, 'dependencies'),
    directDevDependencies: countWorkspaceDependencyEntries(lockText, 'devDependencies'),
    lockedPackages: (packagesText.match(/^\s{4}"[^"]+": \[/gm) ?? []).length,
  };
};
