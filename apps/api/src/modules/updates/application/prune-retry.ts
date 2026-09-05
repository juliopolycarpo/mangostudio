/**
 * Retries a prune `install.ps1 -Prune` could not finish last time — see
 * `domain/prune-retry.ts` for why this only ever applies on Windows. Called
 * once, fire-and-forget, right after `serve` starts listening: a leftover
 * version directory is worth cleaning up, never worth delaying startup for,
 * so the caller never awaits this and every failure only logs.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getRunDir } from '../../../lib/mango-paths';
import { currentInstallOriginProbe } from '../../machine/application/hub-service';
import { detectInstallOrigin, type InstallOriginProbe } from '../domain/install-origin';
import { shouldRetryPrune } from '../domain/prune-retry';
import {
  buildScriptEnv,
  installerArgv,
  writeTempScriptReal,
} from '../infrastructure/installer-invocation';
import { type RunScript, runScript } from '../infrastructure/run-script';

const logger = createDiagnosticLogger('prune-retry');

export interface PruneRetryDeps {
  /** Checked before `probe()`, so a non-Windows start pays nothing for this hook. */
  readonly platform: NodeJS.Platform;
  readonly probe: () => InstallOriginProbe;
  readonly runScript: RunScript;
  readonly which: (name: string) => string | null;
  readonly writeScript: (directory: string) => Promise<string>;
  readonly mkdir: (directory: string) => Promise<void>;
  readonly removeDir: (directory: string) => Promise<void>;
  readonly runDir: () => string;
  readonly env: NodeJS.ProcessEnv;
  readonly pid: number;
}

function resolveDeps(deps: Partial<PruneRetryDeps>): PruneRetryDeps {
  return {
    platform: deps.platform ?? process.platform,
    probe: deps.probe ?? (() => currentInstallOriginProbe()),
    runScript: deps.runScript ?? runScript,
    which: deps.which ?? ((name) => Bun.which(name)),
    writeScript: deps.writeScript ?? ((directory) => writeTempScriptReal(directory, 'ps1')),
    mkdir: deps.mkdir ?? (async (directory) => void (await mkdir(directory, { recursive: true }))),
    removeDir:
      deps.removeDir ??
      (async (directory) => void (await rm(directory, { recursive: true, force: true }))),
    runDir: deps.runDir ?? getRunDir,
    env: deps.env ?? process.env,
    pid: deps.pid ?? process.pid,
  };
}

/**
 * // Usage: void runPruneRetry() — called from startServer() once listening.
 */
export async function runPruneRetry(deps: Partial<PruneRetryDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);
  // Ahead of `probe()`: this runs on the startup tick of every hub, and the
  // probe is a realpath plus a read of `install-origin.json` that no non-
  // Windows start has any use for.
  if (d.platform !== 'win32') return;
  const probe = d.probe();
  const installedVia = detectInstallOrigin(probe);
  const prunePending = installedVia.record?.prunePending;
  if (!shouldRetryPrune({ platform: probe.platform, prunePending })) return;

  const directory = join(d.runDir(), `.prune-retry-${d.pid}`);
  try {
    await d.mkdir(directory);
    const scriptPath = await d.writeScript(directory);
    const argv = installerArgv('ps1', scriptPath, ['-Prune'], d.which);
    const run = d.runScript(argv, { env: buildScriptEnv(d.env, installedVia) });
    for await (const line of run.lines) {
      logger.debug('output', { stream: line.stream, line: line.line });
    }
    const exitCode = await run.exitCode;
    if (exitCode === 0) {
      logger.info('retried', { pending: prunePending });
    } else {
      logger.warn('failed', { pending: prunePending, exitCode });
    }
  } catch (error) {
    logger.warn('failed', { pending: prunePending, error });
  } finally {
    await d.removeDir(directory);
  }
}
