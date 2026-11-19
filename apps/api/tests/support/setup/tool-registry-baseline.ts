/**
 * The tool registry is one process-wide map, and Bun's unisolated lanes run many
 * test files in the same process. A suite that calls `clearRegistry()` and does
 * not put the built-ins back (or swaps a tool for a stub) changes what every
 * later file sees: `generate_image-abort-signal` timed out because an earlier
 * file left `generate_image` unregistered.
 *
 * The preload captures the registry once, right after startup registration, and
 * restores it after every test. Suites may keep their own snapshot/restore; this
 * is the net under them, so a missed restore cannot leak across files.
 */

import { clearRegistry, getAllTools, registerTool } from '../../../src/services/tools/registry';
import type { RegisteredTool } from '../../../src/services/tools/types';

/** Returns the registered tools, by reference, so a restore puts back the same objects. */
export function captureToolRegistryBaseline(): RegisteredTool[] {
  return getAllTools();
}

/**
 * Makes the registry hold exactly the baseline tools again. Does nothing when
 * it already does, which is every test that never touched it.
 * // Usage: restoreToolRegistryBaseline(baseline)
 */
export function restoreToolRegistryBaseline(baseline: readonly RegisteredTool[]): void {
  const current = getAllTools();
  const unchanged =
    current.length === baseline.length && baseline.every((tool, index) => current[index] === tool);
  if (unchanged) return;

  clearRegistry();
  for (const tool of baseline) registerTool(tool);
}
