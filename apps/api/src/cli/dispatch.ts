/**
 * CLI command router. Maps the first user argument to a command handler and
 * turns CliError into a clean stderr message + non-zero exit.
 */

import { parseDoctorArgs, parseEnvArgs, parseLibraryArgs, parseServeArgs } from './args';
import { runDoctor } from './commands/doctor';
import { runEnv } from './commands/env';
import { runKillServer } from './commands/killserver';
import { runLibrary } from './commands/library';
import { runServe } from './commands/serve';
import { runServeInternal } from './commands/serve-internal';
import { runStatus } from './commands/status';
import { runStop } from './commands/stop';
import { runVersion } from './commands/version';
import { CliError } from './errors';
import { writeError } from './output';
import { printHelp, printUnknown } from './usage';

/** Route the first user arg to a command handler. // Usage: await dispatch(['serve', '3000']) */
export async function dispatch(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  try {
    await route(command, rest);
  } catch (error) {
    if (error instanceof CliError) {
      writeError(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function route(command: string | undefined, rest: string[]): Promise<void> {
  switch (command) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      printHelp();
      return;
    case 'serve':
      await runServe(parseServeArgs(rest));
      return;
    // Hidden: re-exec target used by `serve -d`. Not shown in help.
    case '__serve':
      await runServeInternal(parseServeArgs(rest));
      return;
    case 'status':
      await runStatus();
      return;
    case 'stop':
      await runStop();
      return;
    case 'killserver':
      await runKillServer();
      return;
    case 'doctor':
      await runDoctor(parseDoctorArgs(rest));
      return;
    case 'env':
      await runEnv(parseEnvArgs(rest));
      return;
    case 'library':
      await runLibrary(parseLibraryArgs(rest));
      return;
    case 'version':
    case '-v':
    case '--version':
      runVersion();
      return;
    default:
      printUnknown(command);
      printHelp();
      process.exit(1);
  }
}
