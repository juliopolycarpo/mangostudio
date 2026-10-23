#!/usr/bin/env bun
import { frontendBuildCacheArguments } from '@mangostudio/shared/frontend-build/host';
import { ROOT_DIR } from './lib/config';

// Run the guard before Turbo can restore an output. Preserve its full workspace selection.
const child = Bun.spawn(
  ['turbo', 'run', 'build', ...process.argv.slice(2), ...frontendBuildCacheArguments(ROOT_DIR)],
  {
    cwd: ROOT_DIR,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }
);
process.exit(await child.exited);
