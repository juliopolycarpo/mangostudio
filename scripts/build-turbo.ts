#!/usr/bin/env bun
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { frontendBuildCacheArguments } from '@mangostudio/shared/frontend-build/host';

import { ROOT_DIR, WORKSPACES } from './lib/config';
import { captureCommand, runCommand } from './lib/exec';
import { buildWithCleanFrontendOutputs } from './lib/frontend-workspace-outputs';

function targetsThisCheckout(options: readonly string[]): boolean {
  const index = options.findIndex((option) => option === '--cwd' || option.startsWith('--cwd='));
  if (index < 0) return true;
  const value = options[index].startsWith('--cwd=') ? options[index].slice(6) : options[index + 1];
  if (!value) return false;
  try {
    const root = realpathSync.native(ROOT_DIR);
    const cwd = realpathSync.native(resolve(root, value));
    const path = relative(root, cwd);
    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  } catch {
    return false;
  }
}

const forwarded = process.argv.slice(2);
const taskSeparator = forwarded.indexOf('--');
const boundary = taskSeparator < 0 ? forwarded.length : taskSeparator;
const options = forwarded.slice(0, boundary);
const taskArguments = forwarded.slice(boundary);
const cacheArguments = frontendBuildCacheArguments(ROOT_DIR);
const env = { MANGOSTUDIO_FRONTEND_BUN_REVISION: Bun.revision };
const command = ['turbo', 'run', 'build', ...options, ...cacheArguments, ...taskArguments];
const reportsOnly = options.some((option) =>
  /^(?:--(?:dry(?:-run)?|graph|help|version)(?:=|$)|-h$)/.test(option)
);

if (!reportsOnly && cacheArguments.length === 0 && targetsThisCheckout(options)) {
  // Turbo expands selectors, exclusions and dependency tasks before choosing
  // what to restore. Ask for that plan before parking either frontend output.
  const plan = await captureCommand(
    [
      'turbo',
      'run',
      'build',
      '--dry=json',
      ...options.filter((option) => option !== '--json'),
      ...taskArguments,
    ],
    { cwd: ROOT_DIR, env: { ...env, TURBO_CACHE: 'local:,remote:' } }
  );
  if (plan.exitCode !== 0) {
    process.stderr.write(plan.stderr);
    process.exit(plan.exitCode);
  }
  const summary = JSON.parse(plan.stdout) as { tasks?: { taskId: string }[] };
  if (!Array.isArray(summary.tasks)) {
    throw new Error('Turbo build plan: expected a task list | received no tasks array');
  }
  if (summary.tasks.some(({ taskId }) => taskId === `${WORKSPACES.frontend.packageName}#build`)) {
    const status = await buildWithCleanFrontendOutputs(ROOT_DIR, async () => {
      const result = await runCommand('build', command, {
        cwd: ROOT_DIR,
        env,
        stdin: 'inherit',
        logCommand: false,
      });
      return result.exitCode;
    });
    process.exit(status);
  }
}

const child = Bun.spawn(command, {
  cwd: ROOT_DIR,
  env: { ...process.env, ...env },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
