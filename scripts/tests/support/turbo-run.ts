import { join } from 'node:path';

import { ROOT_DIR } from '../../lib/config';

/** Keeps a throwaway Turbo run from reporting telemetry or checking for updates. */
const QUIET_TURBO_ENV = {
  DO_NOT_TRACK: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  TURBO_NO_UPDATE_NOTIFIER: '1',
};

/**
 * The environment a spawned Turbo should see: the caller's, minus every `TURBO_*`
 * variable, then `extraEnv`. A caller's `TURBO_FORCE=true` (or `TURBO_CACHE_DIR`,
 * `TURBO_TEAM`, ...) turns every cache hit these tests assert into a miss, so only
 * the overrides a test passes on purpose reach Turbo.
 *
 * @example
 * Bun.spawn({ cmd, env: hermeticTurboEnv({ TURBO_CACHE_DIR: cacheDir }) });
 */
export function hermeticTurboEnv(
  extraEnv: Readonly<Record<string, string>> = {},
  inherited: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && !key.startsWith('TURBO_')) env[key] = value;
  }
  return { ...env, ...extraEnv, ...QUIET_TURBO_ENV };
}

/** The fields of a `turbo run --dry=json` task the typecheck graph tests read. */
export interface DryRunTask {
  readonly taskId: string;
  readonly task: string;
  /** The package the task runs in, e.g. `@mangostudio/api`; `//` for a root task. */
  readonly package: string;
  /** `<NONEXISTENT>` for a task no package script backs, such as `transit`. */
  readonly command: string;
  readonly hash: string;
  readonly dependencies: readonly string[];
  /** Repo-relative workspace directory, e.g. `apps/api`. */
  readonly directory: string;
  /** Every file Turbo hashed for the task, keyed by workspace-relative path. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly resolvedTaskDefinition: { readonly inputs: readonly string[] };
}

export interface TurboResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the repository's Turbo binary through its fixture owner, with environment overrides.
 *
 * @example
 * const { exitCode } = await runTurbo(root, ['run', 'typecheck'], {}, commands.run);
 */
export function runTurbo(
  cwd: string,
  args: readonly string[],
  extraEnv: Record<string, string>,
  capture: (cmd: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<TurboResult>
): Promise<TurboResult> {
  const cmd = [join(ROOT_DIR, 'node_modules', '.bin', 'turbo'), ...args];
  return capture(cmd, cwd, hermeticTurboEnv(extraEnv));
}

/**
 * Turbo's own answer for a `turbo run` command line: the merged task graph,
 * without executing anything. Throws, naming the exit code and stderr, when
 * Turbo refuses the configuration.
 *
 * @example
 * const tasks = await turboDryRun(ROOT_DIR, ['run', 'typecheck'], commands.run);
 */
export async function turboDryRun(
  cwd: string,
  args: readonly string[],
  capture: (cmd: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<TurboResult>
): Promise<DryRunTask[]> {
  const { exitCode, stdout, stderr } = await runTurbo(cwd, [...args, '--dry=json'], {}, capture);
  if (exitCode !== 0) {
    throw new Error(
      `expected turbo dry run exit: 0 | received: ${exitCode} | args: ${args.join(' ')} | stderr: ${stderr.trim()}`
    );
  }
  return (JSON.parse(stdout) as { tasks: DryRunTask[] }).tasks;
}

/** The tasks a dry run would execute: those backed by a package script. */
export function executableTaskIds(tasks: readonly DryRunTask[]): string[] {
  return tasks
    .filter((task) => task.command !== '<NONEXISTENT>')
    .map((task) => task.taskId)
    .sort();
}
