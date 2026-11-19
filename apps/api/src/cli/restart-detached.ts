/**
 * Bring a detached hub back after its install changed underneath it: check the
 * launcher the restart will exec, stop the old hub, spawn the successor. The
 * check comes first because the stop is not undoable: a manager that left no
 * usable launcher would otherwise cost the operator a running hub.
 */

import { HIDDEN_WINDOW } from '@mangostudio/shared/process';

import type { ServerState } from '../lib/server-state';
import type { HubExecutable } from '../modules/machine/domain/hub-executable';
import { type DetachResult, restartExecutableOptions, spawnDetached } from './detach';
import { CliError } from './errors';
import { readVersionProcess, type VersionProbeProcess } from './version-probe-process';

export interface RestartTargetProcess extends VersionProbeProcess {
  readonly stdout: ReadableStream<Uint8Array>;
}

export type SpawnRestartTarget = (argv: readonly string[]) => RestartTargetProcess;

function spawnRestartTarget(argv: readonly string[]): RestartTargetProcess {
  return Bun.spawn([...argv, '--version'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    ...HIDDEN_WINDOW,
  });
}

/**
 * Run `<launcher> --version` and return what it prints, or throw naming the
 * launcher and why it could not run: gone (a manager that removed the old
 * directory), not executable, or exiting non-zero. Starts no hub.
 * // Usage: await readRestartTargetVersion(['/opt/homebrew/bin/mangostudio']) → '0.1.2'
 */
export async function readRestartTargetVersion(
  argv: readonly string[],
  spawn: SpawnRestartTarget = spawnRestartTarget
): Promise<string> {
  const command = `${argv.join(' ')} --version`;
  const fail = (reason: string): CliError =>
    new CliError(`Cannot run "${command}" (${reason}); the running hub was not stopped.`);

  let child: RestartTargetProcess;
  try {
    child = spawn(argv);
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error));
  }
  let result: { text: string; exitCode: number };
  try {
    result = await readVersionProcess(child, child.stdout, command);
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error));
  }
  if (result.exitCode !== 0) throw fail(`exited with code ${result.exitCode}`);
  const version = result.text.trim();
  if (!version) throw fail('printed no version');
  return version;
}

export interface RestartDetachedInput {
  /** The hub being replaced. */
  readonly state: ServerState;
  /** What this process would re-exec when no launcher applies. */
  readonly executable: Pick<HubExecutable, 'pointer' | 'argv'>;
  /** From `restartLauncher`: the path that follows the manager's upgrade. */
  readonly launcherPath?: string | undefined;
}

export interface RestartDetachedDeps {
  /** Stops `input.state`'s hub and returns once it is gone, throwing when it will not stop. */
  readonly stop: () => Promise<void>;
  readonly spawnDetached?: typeof spawnDetached;
  readonly readTargetVersion?: (argv: readonly string[]) => Promise<string>;
}

/**
 * Stop the detached hub and spawn its successor, waiting on the old pid. A
 * launcher is run with `--version` before anything is stopped, so one that
 * cannot start fails the restart with the old hub still serving.
 * // Usage: await restartDetachedHub({ state, executable, launcherPath }, { stop })
 */
export async function restartDetachedHub(
  input: RestartDetachedInput,
  deps: RestartDetachedDeps
): Promise<DetachResult> {
  if (input.launcherPath) {
    await (deps.readTargetVersion ?? readRestartTargetVersion)([input.launcherPath]);
  }
  await deps.stop();
  return await (deps.spawnDetached ?? spawnDetached)(
    input.state.port,
    input.state.host,
    {},
    {
      waitForPid: input.state.pid,
      ...restartExecutableOptions(input.executable, input.launcherPath),
    }
  );
}
