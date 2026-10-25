#!/usr/bin/env bun
import { frontendBuildCacheArguments } from '@mangostudio/shared/frontend-build/host';
import { ROOT_DIR } from './lib/config';

// Run the guard before Turbo can restore an output. Preserve its full workspace selection.
const forwarded = process.argv.slice(2);
const taskSeparator = forwarded.indexOf('--');
const boundary = taskSeparator < 0 ? forwarded.length : taskSeparator;
const child = Bun.spawn(
  [
    'turbo',
    'run',
    'build',
    ...forwarded.slice(0, boundary),
    ...frontendBuildCacheArguments(ROOT_DIR),
    ...forwarded.slice(boundary),
  ],
  { cwd: ROOT_DIR, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
);
process.exit(await child.exited);
