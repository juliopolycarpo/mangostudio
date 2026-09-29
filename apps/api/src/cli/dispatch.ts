/**
 * CLI command router. Maps the first user argument to a command handler and
 * turns an operator-facing error into a clean stderr message + non-zero exit.
 */

import { releaseRuntimeConnections } from '../services/runtime-client/runtime-connection-release';
import {
  parseDoctorArgs,
  parseEnvArgs,
  parseLibraryArgs,
  parseLogsArgs,
  parseServeArgs,
  parseServiceArgs,
  parseSetupArgs,
  parseStatusArgs,
  parseUpgradeArgs,
} from './args';
import type { runDoctor } from './commands/doctor';
import type { runEnv, runEnvInstall, runEnvToolchain } from './commands/env';
import type { runInstaller } from './commands/installer';
import type { runKillServer } from './commands/killserver';
import type { runLibrary } from './commands/library';
import type { runLogs } from './commands/logs';
import type { runOpen } from './commands/open';
import type { runRestart } from './commands/restart';
import type { runServe } from './commands/serve';
import type { runServeInternal } from './commands/serve-internal';
import type { runService } from './commands/service';
import type { runSetup } from './commands/setup';
import type { runStatus } from './commands/status';
import type { runStop } from './commands/stop';
import type { runUpgrade } from './commands/upgrade';
import type { runVersion } from './commands/version';
import { isOperatorError } from './errors';
import { writeError } from './output';
import { printHelp, printUnknown } from './usage';

/**
 * How each command's implementation is loaded: one loader per command
 * module, called only once that command is selected, so an invocation
 * evaluates its own command's graph and not every other command's.
 */
export interface CommandModules {
  readonly doctor: () => Promise<{ readonly runDoctor: typeof runDoctor }>;
  readonly env: () => Promise<{
    readonly runEnv: typeof runEnv;
    readonly runEnvInstall: typeof runEnvInstall;
    readonly runEnvToolchain: typeof runEnvToolchain;
  }>;
  readonly installer: () => Promise<{ readonly runInstaller: typeof runInstaller }>;
  readonly killserver: () => Promise<{ readonly runKillServer: typeof runKillServer }>;
  readonly library: () => Promise<{ readonly runLibrary: typeof runLibrary }>;
  readonly logs: () => Promise<{ readonly runLogs: typeof runLogs }>;
  readonly open: () => Promise<{ readonly runOpen: typeof runOpen }>;
  readonly restart: () => Promise<{ readonly runRestart: typeof runRestart }>;
  readonly serve: () => Promise<{ readonly runServe: typeof runServe }>;
  readonly serveInternal: () => Promise<{ readonly runServeInternal: typeof runServeInternal }>;
  readonly service: () => Promise<{ readonly runService: typeof runService }>;
  readonly setup: () => Promise<{ readonly runSetup: typeof runSetup }>;
  readonly status: () => Promise<{ readonly runStatus: typeof runStatus }>;
  readonly stop: () => Promise<{ readonly runStop: typeof runStop }>;
  readonly upgrade: () => Promise<{ readonly runUpgrade: typeof runUpgrade }>;
  readonly version: () => Promise<{ readonly runVersion: typeof runVersion }>;
}

/**
 * The real command modules, each behind a dynamic import.
 *
 * // Usage: const { runStop } = await commandModules.stop()
 */
export const commandModules: CommandModules = {
  doctor: () => import('./commands/doctor'),
  env: () => import('./commands/env'),
  installer: () => import('./commands/installer'),
  killserver: () => import('./commands/killserver'),
  library: () => import('./commands/library'),
  logs: () => import('./commands/logs'),
  open: () => import('./commands/open'),
  restart: () => import('./commands/restart'),
  serve: () => import('./commands/serve'),
  serveInternal: () => import('./commands/serve-internal'),
  service: () => import('./commands/service'),
  setup: () => import('./commands/setup'),
  status: () => import('./commands/status'),
  stop: () => import('./commands/stop'),
  upgrade: () => import('./commands/upgrade'),
  version: () => import('./commands/version'),
};

/**
 * Commands that leave a server running after they return. The server owns the
 * runtime connections it opens and closes them itself on shutdown
 * (`start-server.ts`); releasing them when the command returns would take
 * Local away from a hub that is still serving.
 */
const SERVER_COMMANDS: ReadonlySet<string> = new Set(['serve', '__serve']);

/**
 * Route the first user arg to a command handler.
 *
 * Only the selected command's module is loaded (`modules`), after its
 * arguments parse, so a mistyped flag or `--version` never evaluates another
 * command's implementation.
 *
 * Every other command releases the runtime connections it opened before the
 * process is left to exit. Local is a spawned `mangostudio-runtime` child, and
 * a live pipe to it keeps the event loop — and so the CLI — alive forever.
 * The release happens before an operator error exits, too, so the child is
 * asked to unwind rather than orphaned.
 *
 * // Usage: await dispatch(['serve', '3000'])
 */
export async function dispatch(
  args: string[],
  releaseRuntimes: () => Promise<void> = releaseRuntimeConnections,
  modules: CommandModules = commandModules
): Promise<void> {
  const [command, ...rest] = args;
  const release = () =>
    command !== undefined && SERVER_COMMANDS.has(command) ? Promise.resolve() : releaseRuntimes();
  try {
    await route(command, rest, modules);
  } catch (error) {
    // The command's own failure is the one the operator must see; a release
    // that also fails is reported beside it, never in its place.
    await release().catch((releaseError: unknown) => {
      const detail = releaseError instanceof Error ? releaseError.message : String(releaseError);
      writeError(`Could not release runtime connections: ${detail}`);
    });
    if (isOperatorError(error)) {
      writeError(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }
  await release();
}

async function route(
  command: string | undefined,
  rest: string[],
  modules: CommandModules
): Promise<void> {
  switch (command) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      printHelp();
      return;
    case 'setup': {
      const setupArgs = parseSetupArgs(rest);
      const { runSetup } = await modules.setup();
      await runSetup(setupArgs);
      return;
    }
    case 'serve': {
      const serveArgs = parseServeArgs(rest);
      const { runServe } = await modules.serve();
      await runServe(serveArgs);
      return;
    }
    // Hidden: re-exec target used by `serve -d`. Not shown in help.
    case '__serve': {
      const serveArgs = parseServeArgs(rest);
      const { runServeInternal } = await modules.serveInternal();
      await runServeInternal(serveArgs);
      return;
    }
    // Hidden: prints the install script this build embeds. Not shown in
    // help; the release dry-run's drift guard is the only intended caller.
    case '__installer': {
      const { runInstaller } = await modules.installer();
      runInstaller(rest);
      return;
    }
    case 'status': {
      const statusArgs = parseStatusArgs(rest);
      const { runStatus } = await modules.status();
      await runStatus(statusArgs);
      return;
    }
    case 'stop': {
      const { runStop } = await modules.stop();
      await runStop();
      return;
    }
    case 'restart': {
      const { runRestart } = await modules.restart();
      await runRestart();
      return;
    }
    case 'killserver': {
      const { runKillServer } = await modules.killserver();
      await runKillServer();
      return;
    }
    case 'service': {
      const serviceArgs = parseServiceArgs(rest);
      const { runService } = await modules.service();
      await runService(serviceArgs);
      return;
    }
    case 'logs': {
      const logsArgs = parseLogsArgs(rest);
      const { runLogs } = await modules.logs();
      await runLogs(logsArgs);
      return;
    }
    case 'open': {
      const { runOpen } = await modules.open();
      await runOpen();
      return;
    }
    case 'doctor': {
      const doctorArgs = parseDoctorArgs(rest);
      const { runDoctor } = await modules.doctor();
      await runDoctor(doctorArgs);
      return;
    }
    case 'env':
      await routeEnv(rest, modules);
      return;
    case 'library': {
      const libraryArgs = parseLibraryArgs(rest);
      const { runLibrary } = await modules.library();
      await runLibrary(libraryArgs);
      return;
    }
    case 'upgrade':
    case 'update': {
      const upgradeArgs = parseUpgradeArgs(rest);
      const { runUpgrade } = await modules.upgrade();
      // A refused or failed upgrade is an expected outcome, not an operator
      // error — same convention as `env install`'s numeric exit code.
      process.exitCode = await runUpgrade(upgradeArgs);
      return;
    }
    case 'version':
    case '-v':
    case '--version': {
      const { runVersion } = await modules.version();
      runVersion();
      return;
    }
    default:
      printUnknown(command);
      printHelp();
      process.exit(1);
  }
}

async function routeEnv(rest: string[], modules: CommandModules): Promise<void> {
  const envArgs = parseEnvArgs(rest);
  const { runEnv, runEnvInstall, runEnvToolchain } = await modules.env();
  if (envArgs.subcommand === 'install' || envArgs.subcommand === 'update') {
    // A refused or failed install is an expected outcome, not an operator
    // error — it gets a numeric exit code rather than the stderr message
    // the catch block in `dispatch` prints for a `CliError`.
    process.exitCode = await runEnvInstall(envArgs);
    return;
  }
  if (envArgs.subcommand === 'toolchain') {
    await runEnvToolchain(envArgs);
    return;
  }
  await runEnv(envArgs);
}
