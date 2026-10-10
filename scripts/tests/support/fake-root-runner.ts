#!/usr/bin/env bun
// A root runner as `bun run test` has it: starts its command with `runCommand`,
// which gives the child a process group of its own and, when this runner is
// cancelled, stops that whole group and exits 128 + the signal.
//
// Usage: bun fake-root-runner.ts <command> [args...]

import { runCommand } from '../../lib/exec';

/** Where this file lives, for the test that starts it. */
export const FAKE_ROOT_RUNNER = import.meta.path;

if (import.meta.main) {
  const result = await runCommand('lane', process.argv.slice(2));
  process.exit(result.exitCode);
}
