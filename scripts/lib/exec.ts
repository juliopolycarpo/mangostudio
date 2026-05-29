// Process execution primitives: spawn a command, run a workspace script, and
// fan tasks out in parallel. All commands inherit stdio so output streams live.

import { ROOT_DIR, WORKSPACES, type WorkspaceName } from './config';
import { dim, error } from './log';

export interface RunResult {
  label: string;
  exitCode: number;
  duration: number;
}

/**
 * Spawn a command and resolve once it exits, capturing label/exit code/duration.
 * // Usage: await runCommand('build', ['bun', 'run', 'build']);
 */
export async function runCommand(
  label: string,
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): Promise<RunResult> {
  const start = performance.now();
  dim(`  $ ${cmd.join(' ')}`);

  const proc = Bun.spawn({
    cmd,
    cwd: opts?.cwd ?? ROOT_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, ...opts?.env },
  });

  const exitCode = await proc.exited;
  const duration = Math.round(performance.now() - start);

  return { label, exitCode, duration };
}

/** Run `bun run --filter <pkg> <script>` for a workspace. */
// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function runWorkspaceScript(
  workspace: WorkspaceName,
  script: string,
  opts?: { ifPresent?: boolean }
): Promise<RunResult> {
  const ws = WORKSPACES[workspace];
  const cmd = ['bun', 'run'];
  if (opts?.ifPresent) cmd.push('--if-present');
  cmd.push('--filter', ws.packageName, script);
  return runCommand(`${workspace}:${script}`, cmd);
}

/** Run task thunks concurrently and collect every result. */
// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function runParallel(tasks: Array<() => Promise<RunResult>>): Promise<RunResult[]> {
  return Promise.all(tasks.map((t) => t()));
}

/**
 * Wrap an async function as a RunResult for in-process work that has no command
 * line: times it, and reports exit code 1 (printing the message) if it throws.
 * // Usage: results.push(await runTask('clean', () => removePaths(paths)));
 */
export async function runTask(label: string, fn: () => Promise<void>): Promise<RunResult> {
  const start = performance.now();
  let exitCode = 0;
  try {
    await fn();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    exitCode = 1;
  }
  return { label, exitCode, duration: Math.round(performance.now() - start) };
}
