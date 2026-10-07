// Process execution primitives: spawn a command, run a workspace script, and
// fan tasks out in parallel. All commands inherit stdio so output streams live.
// Every `runCommand` child counts against one per-process limit, and on POSIX
// leads its own process group, so cancelling a runner stops the whole tree; see
// ./process-tree for both and for what Windows does instead.

import { availableParallelism } from 'node:os';

import { ROOT_DIR, WORKSPACES, type WorkspaceName } from './config';
import { dim, error } from './log';
import {
  bindDescendantsToRunner,
  ChildSupervisor,
  childLimit,
  processHost,
  RUNNER_GROUP_ENV,
  SlotPool,
  supervisionMode,
} from './process-tree';

export interface RunResult {
  label: string;
  exitCode: number;
  duration: number;
}

export interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn a command and capture its output instead of streaming it, so callers can
 * fold stdout/stderr into an error message or inspect the result. Inherits
 * process.env, optionally extended by `env`.
 * // Usage: const { exitCode, stderr } = await captureCommand(['tar', '-czf', out, dir]);
 */
export async function captureCommand(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): Promise<CaptureResult> {
  const proc = Bun.spawn({
    cmd,
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

/** Built on first use, so a bad MANGO_RUNNER_CONCURRENCY fails the command that hits it. */
let childSlots: SlotPool | undefined;
const supervisor = new ChildSupervisor(processHost());

/**
 * Spawn a command and resolve once it exits, capturing label/exit code/duration.
 * Pass `stdin: 'inherit'` for interactive children (e.g. Turbo's TUI); it stays
 * 'ignore' by default so parallel fan-out never fights over the terminal.
 *
 * At most `MANGO_RUNNER_CONCURRENCY` (default 16) children run at once per
 * process, however many `runParallel` calls are nested; the rest wait for a
 * slot. When the runner receives SIGINT, SIGTERM or SIGHUP, every child and
 * everything it started is stopped, and the runner exits 128 + the signal.
 * // Usage: await runCommand('build', ['bun', 'run', 'build']);
 */
export async function runCommand(
  label: string,
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string>; stdin?: 'inherit' | 'ignore' }
): Promise<RunResult> {
  childSlots ??= new SlotPool(childLimit());
  const releaseSlot = await childSlots.acquire();
  let result: RunResult;
  try {
    result = await spawnAndWait(label, cmd, opts);
  } finally {
    releaseSlot();
  }

  if (supervisor.cancelling) await exitIsComing();
  return result;
}

/**
 * Never settles. Once a cancelling signal arrived the supervisor owns the exit
 * and ends the process with the signal's status; letting a caller resume would
 * race it with a summary and `process.exit(1)`.
 */
function exitIsComing(): Promise<never> {
  return new Promise<never>(() => undefined);
}

async function spawnAndWait(
  label: string,
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string>; stdin?: 'inherit' | 'ignore' }
): Promise<RunResult> {
  if (supervisor.cancelling) await exitIsComing();
  await bindDescendantsToRunner();

  const start = performance.now();
  dim(`  $ ${cmd.join(' ')}`);

  const mode = supervisionMode(opts?.stdin);
  const proc = Bun.spawn({
    cmd,
    cwd: opts?.cwd ?? ROOT_DIR,
    stdin: opts?.stdin ?? 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      ...opts?.env,
      ...(mode === 'group' ? { [RUNNER_GROUP_ENV]: String(process.pid) } : {}),
    },
    detached: mode === 'group',
  });

  const release =
    mode === 'none'
      ? undefined
      : supervisor.adopt({
          label,
          pid: proc.pid,
          ownsGroup: mode === 'group',
          exited: proc.exited,
          signal: (signal) => proc.kill(signal),
        });
  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    release?.();
  }
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

/**
 * Run task thunks one at a time, in order, and collect every result. Unlike
 * runParallel this is for tasks that write to the same tree — formatters, or a
 * test suite whose two halves share a build directory — where concurrent runs
 * would race each other rather than just interleave output.
 * // Usage: await runSequential([() => fmt('biome'), () => fmt('dprint')]);
 */
export async function runSequential(tasks: Array<() => Promise<RunResult>>): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const task of tasks) results.push(await task());
  return results;
}

/** Run task thunks concurrently and collect every result. */
// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function runParallel(tasks: Array<() => Promise<RunResult>>): Promise<RunResult[]> {
  return Promise.all(tasks.map((t) => t()));
}

/**
 * Run tasks with at most `limit` in flight. Unlike runParallel, this bounds
 * concurrency for CPU/IO-heavy work (compression) that would thrash the runner
 * if every task started at once. Results preserve input order.
 * // Usage: await mapWithConcurrency(targets, 4, (t) => archive(t));
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  if (Number.isNaN(limit)) {
    throw new TypeError(`mapWithConcurrency: limit must be a number, received ${limit}`);
  }

  // Math.floor keeps a fractional limit from inflating the worker count; Infinity
  // survives it and collapses to items.length (fully parallel).
  const concurrency = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (failed) {
        return;
      }

      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await fn(items[index]);
      } catch (caught) {
        if (!failed) {
          failed = true;
          firstError = caught;
        }
        return;
      }
    }
  });

  await Promise.all(workers);
  if (failed) {
    throw firstError;
  }

  return results;
}

/** Release archive/bundle parallelism; override with MANGO_ARCHIVE_CONCURRENCY. */
export function archiveConcurrency(): number {
  const raw = process.env.MANGO_ARCHIVE_CONCURRENCY;
  if (raw === undefined || raw === '') {
    return Math.max(1, availableParallelism());
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid MANGO_ARCHIVE_CONCURRENCY: ${raw}`);
  }

  return parsed;
}

/**
 * Wrap in-process work (sync or async) as a RunResult for steps that have no
 * command line: times it, and reports exit code 1 (printing the message) if it
 * throws.
 * // Usage: results.push(await runTask('clean', () => removePaths(paths)));
 */
export async function runTask(label: string, fn: () => void | Promise<void>): Promise<RunResult> {
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
