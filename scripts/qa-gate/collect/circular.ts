// Circular dependency count across the discovered JS workspaces via
// madge --circular --json.

import { runCapture } from './support';

type Run = (cmd: readonly string[]) => Promise<{ readonly stdout: string }>;

/**
 * Total number of circular dependency cycles across the given component roots.
 * `run` is injected so tests can fake madge.
 * // Usage: await countCircularDeps(['apps/api', 'packages/protocol'])
 */
export const countCircularDeps = async (
  roots: readonly string[],
  run: Run = runCapture
): Promise<number> => {
  const counts = await Promise.all(
    roots.map(async (root) => {
      const { stdout } = await run([
        'bunx',
        'madge',
        '--circular',
        '--extensions',
        'ts,tsx',
        '--json',
        root,
      ]);
      const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(
          `madge output for ${root} is ${JSON.stringify(parsed)}; expected a JSON array of cycles`
        );
      }
      return parsed.length;
    })
  );
  return counts.reduce((sum, count) => sum + count, 0);
};
