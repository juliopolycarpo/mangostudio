import { createImportCycleCommand } from '../../lib/import-cycles';
import type { ComponentSpec } from './registry';
import { runCapture, type RunResult } from './support';

type Run = (cmd: readonly string[]) => Promise<RunResult>;

/** Select JS workspaces and scripts as the roots for one cycle scan.
 * @example circularRoots(specs);
 */
export const circularRoots = (specs: readonly ComponentSpec[]): string[] =>
  specs
    .filter((spec) => spec.kind === 'workspace' || spec.kind === 'scripts')
    .map((spec) => spec.root);

/** Validate the complete scanner report before using its count.
 * @example parseCycleReport(await runCapture(command));
 */
export function parseCycleReport(result: RunResult): number {
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Invalid cycle report: expected JSON | received ${JSON.stringify(result.stdout.slice(0, 300))}; stderr ${JSON.stringify(result.stderr.slice(0, 300))}`
    );
  }
  if (!value || typeof value !== 'object' || !('cycles' in value) || !Array.isArray(value.cycles)) {
    throw new Error(
      `Invalid cycle report: expected cycles array | received ${JSON.stringify(value)}`
    );
  }
  for (const cycle of value.cycles) {
    if (
      !Array.isArray(cycle) ||
      cycle.length < 2 ||
      cycle.some((path: unknown) => typeof path !== 'string' || !path) ||
      cycle[0] !== cycle.at(-1)
    ) {
      throw new Error(
        `Invalid cycle report: expected a closed path of nonempty filenames | received ${JSON.stringify(cycle)}`
      );
    }
  }
  const expected = value.cycles.length ? 1 : 0;
  if (result.exitCode !== expected)
    throw new Error(
      `Invalid cycle report: expected exit ${expected} | received ${result.exitCode}: ${result.stderr.slice(0, 300)}`
    );
  return value.cycles.length;
}

/** Count cycle witnesses across all roots with a single complete scan.
 * @example await countCircularDeps(['apps/api', 'packages/protocol']);
 */
export const countCircularDeps = async (
  roots: readonly string[],
  run: Run = runCapture
): Promise<number> => {
  if (roots.length === 0) return 0;
  return parseCycleReport(await run(createImportCycleCommand(roots, 'json')));
};
