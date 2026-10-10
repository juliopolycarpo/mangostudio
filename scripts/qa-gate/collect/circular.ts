// Import cycle witnesses across discovered JS workspaces and Bun scripts.

import { createImportCycleCommand } from '../../lib/import-cycles';
import { countBiomeCycleWitnesses, parseBiomeCycleReport } from './biome-cycles';
import type { ComponentSpec } from './registry';
import { runCapture } from './support';

type Run = (
  cmd: readonly string[]
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

/**
 * Roots Biome can scan: every JS workspace and the Bun-native `scripts/` tree.
 * Crates are Rust and have no JavaScript import graph.
 * // Usage: countCircularDeps(circularRoots(specs))
 */
export const circularRoots = (specs: readonly ComponentSpec[]): string[] =>
  specs
    .filter((spec) => spec.kind === 'workspace' || spec.kind === 'scripts')
    .map((spec) => spec.root);

/**
 * Count deduplicated Biome cycle witnesses, including type-only and self imports.
 * All roots share one scan so cross-workspace cycles are counted once. A clean
 * JSON scan returns zero; cycles need Biome's text trace because its JSON
 * reporter omits the trace. `run` is injected for tests.
 * // Usage: await countCircularDeps(['apps/api', 'packages/protocol'])
 */
export const countCircularDeps = async (
  roots: readonly string[],
  run: Run = runCapture
): Promise<number> => {
  if (roots.length === 0) return 0;
  const diagnostics = parseBiomeCycleReport(await run(createImportCycleCommand(roots, 'json')));
  if (diagnostics.length === 0) return 0;
  return countBiomeCycleWitnesses(diagnostics, await run(createImportCycleCommand(roots)));
};
