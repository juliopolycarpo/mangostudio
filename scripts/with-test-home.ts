#!/usr/bin/env bun
// Runs a command with a throwaway HOME (and USERPROFILE), so the tests under it
// cannot reach the developer's real `~/.mango` or `~/.claude`. The API
// workspace's `test:*` scripts start `bun test` through it; see
// scripts/lib/test-home.ts for why this has to be the launcher.
//
// Usage: bun ../../scripts/with-test-home.ts bun test --timeout 15000 tests/unit
//        bun ../../scripts/with-test-home.ts --keep-build-version bash release-smoke.sh
//
// `--keep-build-version` keeps an exported VERSION, which the launcher drops by
// default: only a release job whose mounted runtime must report the hub's
// version passes it.

import { parseLauncherArgs, runWithTestHome } from './lib/test-home';

if (import.meta.main) {
  const { options, command } = parseLauncherArgs(process.argv.slice(2));
  if (command.length === 0) {
    process.stderr.write(
      'Usage: bun scripts/with-test-home.ts [--keep-build-version] <command> [args...]\n'
    );
    process.exit(2);
  }
  process.exit(await runWithTestHome(command, process.env, undefined, options));
}
