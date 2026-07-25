// Process execution primitives: spawn a command, run a workspace script, and
// fan tasks out in parallel. All commands inherit stdio so output streams live.

import { availableParallelism } from 'node:os';

import { ROOT_DIR, WORKSPACES, type WorkspaceName } from './config';
import { dim, error } from './log';

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

/**
 * Spawn a command and resolve once it exits, capturing label/exit code/duration.
 * Pass `stdin: 'inherit'` for interactive children (e.g. Turbo's TUI); it stays
 * 'ignore' by default so parallel fan-out never fights over the terminal.
 * // Usage: await runCommand('build', ['bun', 'run', 'build']);
 */
export async function runCommand(
  label: string,
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string>; stdin?: 'inherit' | 'ignore' }
): Promise<RunResult> {
  const start = performance.now();
  dim(`  $ ${cmd.join(' ')}`);

  const proc = Bun.spawn({
    cmd,
    cwd: opts?.cwd ?? ROOT_DIR,
    stdin: opts?.stdin ?? 'ignore',
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

  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let firstError: unknown;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (firstError !== undefined) {
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
        if (firstError === undefined) {
          firstError = caught;
        }
        return;
      }
    }
  });

  await Promise.all(workers);
  if (firstError !== undefined) {
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
