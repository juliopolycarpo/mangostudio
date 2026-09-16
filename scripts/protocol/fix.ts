/**
 * The protocol-specific half of `bun run fix`: rustfmt over the crate.
 *
 * Biome and dprint are the repository root's, and `bun run fix` already applies
 * them to this package with everything else.
 *
 * @example
 * bun ./scripts/protocol/fix.ts
 */

import { ROOT_DIR } from '../lib/config';
import { exitWithResults, runCommand, runSequential } from '../lib/runner';
import { hasCargo, warnNoCargo } from './toolchain';

if (!hasCargo()) {
  warnNoCargo();
  process.exit(0);
}

exitWithResults(
  await runSequential([
    () => runCommand('protocol:cargo-fmt', ['cargo', 'fmt', '--all'], { cwd: ROOT_DIR }),
  ])
);
