/**
 * The protocol-specific half of `bun run test`: the TypeScript suite, then the
 * Rust suite.
 *
 * The interop suites under `packages/protocol/tests/interop/` drive the Rust
 * example from TypeScript, so they run only when Cargo is present and the run
 * was not narrowed to one side. `MANGO_INTEROP` is how they are turned on;
 * without it they skip, which is what keeps a `--ts-only` run from needing a
 * Rust toolchain.
 *
 * Flags: `--ts-only`, `--rs-only`. Extra Bun test arguments go after `--`.
 *
 * @example
 * bun ./scripts/protocol/test.ts --ts-only -- --test-name-pattern codec
 */

import { ROOT_DIR } from '../lib/config';
import { exitWithResults, type RunResult, runCommand, runSequential } from '../lib/runner';
import { protocolTestTasks } from './tasks';

const separator = process.argv.indexOf('--');
const args = process.argv.slice(2, separator === -1 ? undefined : separator);
const bunTestArgs = separator === -1 ? [] : process.argv.slice(separator + 1);

const tasks: Array<() => Promise<RunResult>> = protocolTestTasks(args, bunTestArgs).map(
  (task) => () =>
    runCommand(task.label, task.cmd, { cwd: ROOT_DIR, ...(task.env ? { env: task.env } : {}) })
);

exitWithResults(await runSequential(tasks));
