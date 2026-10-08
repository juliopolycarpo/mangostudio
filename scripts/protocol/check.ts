/**
 * The protocol-specific half of `bun run check`: the package's typecheck and
 * circular-import scan, the spec verifier, the TypeScript/Rust schema equality
 * check, the fixture generators' staleness checks, the manifest lockstep, and —
 * when a Rust toolchain is present — rustfmt, Clippy, `cargo doc` with warnings
 * denied, Clippy again over the full feature powerset, and the cross-language
 * round trip.
 *
 * The workspace Biome task enforces value, type-only and self-import cycles
 * even when this command runs alone. The repository root owns dprint.
 *
 * Flags: `--skip-format` (no rustfmt), `--ts-only`, `--rs-only`.
 *
 * @example
 * bun ./scripts/protocol/check.ts --ts-only
 */

import { ROOT_DIR } from '../lib/config';
import { exitWithResults, type RunResult, runCommand, runParallel } from '../lib/runner';
import { protocolCheckTasks } from './tasks';

const args = process.argv.slice(2);
const run = (label: string, cmd: string[], env?: Record<string, string>): Promise<RunResult> =>
  runCommand(label, cmd, { cwd: ROOT_DIR, ...(env ? { env } : {}) });

const tasks: Array<() => Promise<RunResult>> = protocolCheckTasks(args).map(
  (task) => () => run(task.label, task.cmd, task.env)
);

exitWithResults(await runParallel(tasks));
