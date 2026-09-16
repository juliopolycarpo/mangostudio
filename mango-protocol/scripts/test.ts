/**
 * `bun run test`: the TypeScript suite, then the Rust suite.
 *
 * The interop suites under `packages/protocol/tests/interop/` drive the Rust
 * example from TypeScript, so they run only when Cargo is present and the run
 * was not narrowed to one side. `MANGO_INTEROP` is how they are turned on;
 * without it they skip, which is what keeps a `--ts-only` run from needing a
 * Rust toolchain.
 *
 * Flags: `--ts-only`, `--rs-only`. Extra Bun test arguments go after `--`.
 */

import { exitWith, hasCargo, hasFlag, runSequential, task, warnNoCargo } from './lib';

const tsOnly = hasFlag('--ts-only');
const rsOnly = hasFlag('--rs-only');
const separator = process.argv.indexOf('--');
const bunTestArgs = separator === -1 ? [] : process.argv.slice(separator + 1);

const tasks = [];
const interop = !tsOnly && hasCargo() ? { MANGO_INTEROP: '1' } : undefined;
if (!rsOnly) {
  tasks.push(
    task('bun test', ['bun', 'test', '--timeout', '15000', ...bunTestArgs], undefined, interop)
  );
}
if (!tsOnly) {
  if (hasCargo()) {
    tasks.push(
      task('cargo test', ['cargo', 'test', '--all-targets', '--all-features', '--locked'])
    );
    tasks.push(task('cargo test --doc', ['cargo', 'test', '--doc', '--all-features', '--locked']));
  } else {
    warnNoCargo();
  }
}

exitWith(await runSequential(tasks));
