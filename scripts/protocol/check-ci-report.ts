/**
 * Internal companion for canonical Check reports, whose supervised component workers
 * already capture protocol TypeScript diagnostics. Public protocol checks retain typechecking.
 * @example bun ./scripts/protocol/check-ci-report.ts
 */
import { ROOT_DIR } from '../lib/config';
import { exitWithResults, runCommand } from '../lib/runner';
import { runProtocolTasks } from './run-tasks';
import { protocolCheckTasks } from './tasks';

const args = process.argv.slice(2);
if (args.length)
  throw new Error(
    `CI report protocol companion: expected no arguments; received ${JSON.stringify(args)}`
  );

exitWithResults(
  await runProtocolTasks(
    protocolCheckTasks(['--ts-only'], undefined, undefined, { typecheck: false }),
    (task) =>
      runCommand(task.label, task.cmd, { cwd: ROOT_DIR, ...(task.env ? { env: task.env } : {}) })
  )
);
