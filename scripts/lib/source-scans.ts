// The source scans `bun run check` runs as their own processes. Each one parses
// hundreds of files synchronously (the shared-root scan takes about four
// seconds), so running it on the runner's thread held back every subprocess the
// runner had still to spawn and every exit it had still to observe.

import { assertFrontendApiImportBoundary } from './frontend-api-import-boundary';
import { assertNoProductionNodeEnvBranches } from './no-node-env-branches';
import { assertNoSharedRootImports } from './shared-root-import-boundary';

export const SOURCE_SCANS = {
  'node-env-branches': () => assertNoProductionNodeEnvBranches(),
  'frontend-api-import-boundary': () => assertFrontendApiImportBoundary(),
  'shared-import-boundary': () => assertNoSharedRootImports(),
} as const satisfies Record<string, () => void | Promise<void>>;

export type SourceScanName = keyof typeof SOURCE_SCANS;

/** The entry script, relative to the repository root. */
const SOURCE_SCAN_SCRIPT = './scripts/check-source-scan.ts';

/**
 * The command that runs one source scan in its own process, from the
 * repository root.
 *
 * @example
 * createSourceScanCommand('shared-import-boundary');
 * // ['bun', './scripts/check-source-scan.ts', 'shared-import-boundary']
 */
export function createSourceScanCommand(name: SourceScanName): string[] {
  return ['bun', SOURCE_SCAN_SCRIPT, name];
}

/**
 * Resolve the scan a command line names, or throw naming what it received.
 *
 * @example
 * resolveSourceScan(['node-env-branches'])(); // runs the scan
 */
export function resolveSourceScan(args: readonly string[]): () => void | Promise<void> {
  const [name, ...rest] = args;
  if (name === undefined || rest.length > 0 || !Object.hasOwn(SOURCE_SCANS, name)) {
    throw new Error(
      `(check-source-scan): expected one scan name: ${Object.keys(SOURCE_SCANS).join(' | ')} | received: ${args.length === 0 ? 'no argument' : args.join(' ')}`
    );
  }
  return SOURCE_SCANS[name as SourceScanName];
}
