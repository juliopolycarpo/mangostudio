import { captureBackup, type CaptureOptions } from '../../backup/capture';
import { getConfig, getVersion } from '../../lib/config';
import { isStateLive, readState } from '../../lib/server-state';
import { CliError } from '../errors';
import { writeLine } from '../output';
import { createProcessController } from '../process-control';

/** Parse the bounded capture command without loading application services. */
export function parseBackupArgs(args: string[]): CaptureOptions {
  let output: string | undefined;
  let checkpoints = true;
  let includeSecrets = false;
  for (const arg of args) {
    if (arg === '--no-checkpoints') checkpoints = false;
    else if (arg === '--include-secrets') includeSecrets = true;
    else if (arg.startsWith('-'))
      throw new CliError(
        'Unknown backup option. Usage: backup <archive.tar.gz> [--no-checkpoints] [--include-secrets]'
      );
    else if (output === undefined) output = arg;
    else throw new CliError('Backup accepts exactly one output archive.');
  }
  if (!output) throw new CliError('Missing backup archive path. Usage: backup <archive.tar.gz>');
  return { output, checkpoints, includeSecrets };
}

/** Capture configured user data only after the running Hub has stopped. */
export async function runBackup(options: CaptureOptions): Promise<void> {
  const state = await readState();
  if (state && isStateLive(state, createProcessController().isAlive)) {
    throw new CliError('Stop the Hub and external data writers before backup.');
  }
  if (options.includeSecrets) {
    writeLine(
      'WARNING: --include-secrets exports only the configured Hub auth secret. Protect this archive. OS keychain, connector and vendor-managed credentials remain excluded.'
    );
  }
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(new CliError('Backup canceled. No complete archive was published.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const manifest = await captureBackup(
      getConfig(),
      { ...options, signal: controller.signal },
      getVersion()
    );
    writeLine(
      `Backup captured: ${manifest.files.length} files. Reauthorize connectors and environments after recovery.`
    );
  } catch (error) {
    throw error instanceof CliError
      ? error
      : new CliError(error instanceof Error ? error.message : 'Backup failed.');
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
