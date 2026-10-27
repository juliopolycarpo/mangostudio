/**
 * The protocol-specific half of `bun run check`: the package's typecheck and
 * circular-import scan, the spec verifier, the TypeScript/Rust schema equality
 * check, the fixture generators' staleness checks, the manifest lockstep, and —
 * when a Rust toolchain is present — rustfmt, Clippy, `cargo doc` with warnings
 * denied, Clippy again over the full feature powerset (two partitions at once,
 * each in its own Cargo target directory, and the run fails unless both ran
 * and passed), and the cross-language round trip.
 *
 * The workspace lint task runs with the protocol check. The repository root
 * owns Bun formatting; Dockerfiles are the only excluded file family.
 *
 * Flags: `--skip-format` (no rustfmt), `--ts-only`, `--rs-only`.
 *
 * @example
 * bun ./scripts/protocol/check.ts --ts-only
 */

import { ROOT_DIR } from '../lib/config';
import { exitWithResults, runCommand } from '../lib/runner';
import { runProtocolTasks } from './run-tasks';
import { protocolCheckTasks } from './tasks';

const args = process.argv.slice(2);

exitWithResults(
  await runProtocolTasks(protocolCheckTasks(args), (task) =>
    runCommand(task.label, task.cmd, { cwd: ROOT_DIR, ...(task.env ? { env: task.env } : {}) })
  )
);
