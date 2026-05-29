// Circular dependency count across workspaces via madge --circular --json.

import { ALL_WORKSPACE_NAMES } from '../../lib/config';
import { runCapture } from './support';

/** Total number of circular dependency cycles across all workspaces. */
export const countCircularDeps = async (): Promise<number> => {
  const counts = await Promise.all(
    ALL_WORKSPACE_NAMES.map(async (workspace) => {
      const { stdout } = await runCapture([
        'bunx',
        'madge',
        '--circular',
        '--extensions',
        'ts,tsx',
        '--json',
        `apps/${workspace}`,
      ]);
      const trimmed = stdout.trim() || '[]';
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) ? parsed.length : 0;
    })
  );
  return counts.reduce((sum, count) => sum + count, 0);
};
