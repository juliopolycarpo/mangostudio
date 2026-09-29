// Circular dependency count across the discovered JS workspaces via
// madge --circular --json.

import { runCapture } from './support';

type Run = (
  cmd: readonly string[]
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

const MAX_STDERR_SHOWN = 300;

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
      const { stdout, stderr, exitCode } = await run([
        'bunx',
        'madge',
        '--circular',
        '--extensions',
        'ts,tsx',
        '--json',
        root,
      ]);
      // madge exits 1 both when it finds cycles (JSON on stdout) and when it
      // fails (nothing on stdout), and prints `[]` for a clean run: empty output
      // is a failure, never zero cycles.
      if (stdout.trim() === '') {
        throw new Error(
          `madge printed no output for ${root} (exit ${exitCode}): ${stderr.trim().slice(0, MAX_STDERR_SHOWN)}`
        );
      }
      const parsed = JSON.parse(stdout) as unknown;
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
