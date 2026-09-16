/**
 * Shared runner for the root scripts: spawns one command, streams its output,
 * and reports a named result so `check`, `test` and `fix` print one summary.
 *
 * @example
 * const results = await runAll([task('biome', ['bunx', 'biome', 'check', '.'])]);
 * exitWith(results);
 */

import { fileURLToPath } from 'node:url';

export interface TaskResult {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
}

export interface Task {
  readonly name: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  /** Extra environment variables, merged over the current process's own. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Repository root as a native path (a URL pathname would keep a leading slash on Windows). */
export const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

export function task(
  name: string,
  argv: readonly string[],
  cwd?: string,
  env?: Readonly<Record<string, string>>
): Task {
  return {
    name,
    argv,
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
  };
}

/**
 * Resolves the command of an argv so the spawn works on every platform:
 * `bun` and `bunx` become the running Bun binary (`bunx` is `bun x`), and any
 * other command is looked up on PATH, which honours PATHEXT on Windows where a
 * bare name such as `cargo` would not spawn.
 *
 * @example
 * resolveArgv(['bunx', 'biome', 'check']); // [process.execPath, 'x', 'biome', 'check']
 */
export function resolveArgv(argv: readonly string[]): string[] {
  const [command = '', ...rest] = argv;
  if (command === 'bun') return [process.execPath, ...rest];
  if (command === 'bunx') return [process.execPath, 'x', ...rest];
  return [Bun.which(command) ?? command, ...rest];
}

/** Runs one task to completion, inheriting stdio so output stays readable. */
export async function runTask(item: Task): Promise<TaskResult> {
  const started = performance.now();
  console.log(`\n▶ ${item.name}: ${item.argv.join(' ')}`);
  const child = Bun.spawn(resolveArgv(item.argv), {
    cwd: item.cwd ?? ROOT_DIR,
    ...(item.env === undefined ? {} : { env: { ...process.env, ...item.env } }),
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  });
  const code = await child.exited;
  return { name: item.name, ok: code === 0, durationMs: performance.now() - started };
}

/** Runs tasks in sequence; formatters and tests write to the same tree, so no races. */
export async function runSequential(tasks: readonly Task[]): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const item of tasks) results.push(await runTask(item));
  return results;
}

/** Runs read-only tasks concurrently. */
export function runParallel(tasks: readonly Task[]): Promise<TaskResult[]> {
  return Promise.all(tasks.map((item) => runTask(item)));
}

export function exitWith(results: readonly TaskResult[]): never {
  console.log('\nSummary');
  for (const result of results) {
    const seconds = (result.durationMs / 1000).toFixed(1);
    console.log(`  ${result.ok ? '✔' : '✘'} ${result.name} (${seconds}s)`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} task(s) failed: ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll tasks passed.');
  process.exit(0);
}

/** True when the flag is present in argv. */
export function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

/** True when `cargo` resolves on PATH; the Rust half is skipped with a warning otherwise. */
export function hasCargo(): boolean {
  return Bun.which('cargo') !== null;
}

export function warnNoCargo(): void {
  console.warn('cargo not found on PATH; skipping the Rust half. CI runs it.');
}

/** True when `cargo-hack` resolves on PATH; CI installs it via `taiki-e/install-action`. */
export function hasCargoHack(): boolean {
  return Bun.which('cargo-hack') !== null;
}

export function warnNoCargoHack(): void {
  console.warn('cargo-hack not found on PATH; skipping the feature-powerset check. CI runs it.');
}
