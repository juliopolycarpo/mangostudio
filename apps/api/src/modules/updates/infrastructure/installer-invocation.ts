/**
 * How the embedded install script is invoked: where it gets written, the argv
 * that runs it under each shell, and the environment it receives. Every caller
 * that shells out to `install.sh`/`install.ps1` — the upgrade engine's install
 * and rollback paths, and the start-time prune retry — goes through here, so
 * the interpreter flags and the env passthrough are stated once.
 */

import { writeFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { WINDOWS_SYSTEM_ENV_KEYS } from '../../../cli/detach';
import type { InstallOrigin } from '../domain/install-origin';
import {
  embeddedInstaller,
  embeddedInstallerFileName,
  type InstallerKind,
} from './embedded-installers';

/**
 * Env keys the embedded install script needs, deduped against
 * `WINDOWS_SYSTEM_ENV_KEYS` (detach.ts) rather than repeating the ones this
 * list already names (LOCALAPPDATA, SystemRoot). Without the rest of that
 * Windows block, install.ps1's `Get-Platform` cannot classify the host
 * architecture (PROCESSOR_ARCHITECTURE/PROCESSOR_ARCHITEW6432) and, even once
 * it does, PowerShell 5.1's `& $exe '--version'` smoke check needs PATHEXT to
 * resolve the target as executable. `runScript` (run-script.ts) replaces
 * rather than merges the child's environment, so a missing key here is
 * simply gone for the whole run.
 */
const SCRIPT_ENV_PASSTHROUGH: readonly string[] = Array.from(
  new Set<string>([
    'PATH',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    // install.sh's mktemp -d reads TMPDIR (POSIX); not in the brief's list, but
    // without it a HOME override in a test or a sandboxed run cannot steer
    // where the script stages its own extraction.
    'TMPDIR',
    ...WINDOWS_SYSTEM_ENV_KEYS,
  ])
);

/**
 * Env the embedded install script receives: the passthrough set plus what
 * tells it this is an upgrade. Also used by `prune-retry.ts` for the
 * `-Prune` retry on start — `MANGOSTUDIO_INSTALL_ORIGIN` is harmless there
 * since `-Prune`/`--prune` never reads it, and the install dir/bin dir
 * overrides are exactly what a prune needs to find the right root.
 * // Usage: buildScriptEnv(process.env, installedVia)
 */
export function buildScriptEnv(
  env: NodeJS.ProcessEnv,
  installedVia: InstallOrigin
): Record<string, string> {
  const scriptEnv: Record<string, string> = {};
  for (const key of SCRIPT_ENV_PASSTHROUGH) {
    const value = env[key];
    if (value !== undefined) scriptEnv[key] = value;
  }
  scriptEnv.MANGOSTUDIO_INSTALL_ORIGIN = 'upgrade';
  if (installedVia.distRoot !== undefined)
    scriptEnv.MANGOSTUDIO_INSTALL_DIR = installedVia.distRoot;
  if (installedVia.record?.binDir !== undefined) {
    scriptEnv.MANGOSTUDIO_BIN_DIR = installedVia.record.binDir;
  }
  return scriptEnv;
}

/** PowerShell 7 when the host has it, the 5.1 that ships with Windows otherwise. */
function powershellInterpreter(which: (name: string) => string | null): string {
  return which('pwsh') !== null ? 'pwsh' : 'powershell.exe';
}

/**
 * argv that runs the embedded script with `flags`, under the interpreter its
 * shell needs. The PowerShell prelude is stated once here: a script written to
 * a temp file only runs under a non-interactive, profile-free host with the
 * execution policy bypassed. // Usage: installerArgv('sh', path, ['--prune'], which)
 */
export function installerArgv(
  kind: InstallerKind,
  scriptPath: string,
  flags: readonly string[],
  which: (name: string) => string | null
): string[] {
  if (kind === 'sh') return ['bash', scriptPath, ...flags];
  return [
    powershellInterpreter(which),
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    ...flags,
  ];
}

/**
 * The flags that tell the script to install `archivePath`, in the spelling its
 * shell uses. `--version`/`-Version` is passed for every kind, not just
 * `npm-tarball`: a canary archive's file name only carries the bare
 * `<major>.<minor>.<patch>-canary`, but the resolved version (from the canary
 * manifest) carries the full `<version>.<sha7>` the binary reports — without it
 * install.sh falls back to deriving the version from the file name and the
 * post-install smoke check compares that truncated string against `--version`,
 * failing every canary self-upgrade.
 * // Usage: selfInstallFlags('sh', '/tmp/a.tar.gz', '0.1.1')
 */
export function selfInstallFlags(
  kind: InstallerKind,
  archivePath: string,
  version: string
): string[] {
  return kind === 'sh'
    ? ['--local', archivePath, '--version', version]
    : ['-Local', archivePath, '-Version', version];
}

/**
 * The flags for the script's `--use`/`-Use` path — no download, just a pointer
 * swap back to a version already on disk. // Usage: useVersionFlags('ps1', '0.1.0')
 */
export function useVersionFlags(kind: InstallerKind, version: string): string[] {
  return kind === 'sh' ? ['--use', version] : ['-Use', version];
}

/**
 * Write the embedded script into `directory` and return its path.
 * // Usage: writeTempScriptReal(stagingDir, 'sh')
 */
export async function writeTempScriptReal(directory: string, kind: InstallerKind): Promise<string> {
  const join = process.platform === 'win32' ? win32.join : posix.join;
  const path = join(directory, embeddedInstallerFileName(kind));
  await writeFile(path, embeddedInstaller(kind), { mode: kind === 'sh' ? 0o755 : 0o644 });
  return path;
}
