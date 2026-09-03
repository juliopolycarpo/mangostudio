import { win32 } from 'node:path';
import type { RuntimeInstallation } from '../schemas';
import { normalizedPath } from './binary-scan';

/**
 * Whether winget owns an installation, as far as `winget list` can say.
 * `unknown` covers everything the probe could not read cleanly — the binary
 * missing, a timeout, an exit code the parser has never seen — because a
 * shrug must never be read as "not installed" and offer an install winget
 * would refuse.
 */
export type WingetOwnership = 'owned' | 'not-owned' | 'unknown';

/** The only Node package MangoStudio ever asks winget about. */
export const NODE_LTS_WINGET_PACKAGE_ID = 'OpenJS.NodeJS.LTS';

/** `winget list` argv for a package id, disabling every prompt a host adapter cannot answer. */
export function WINGET_LIST_ARGV(packageId: string): string[] {
  return [
    'list',
    '--id',
    packageId,
    '--exact',
    '--accept-source-agreements',
    '--disable-interactivity',
  ];
}

/**
 * `winget list --id <id> --exact` reports "no packages found matching the
 * input criteria" with exit code `0x8A150014` — the one exit code this parser
 * treats as a definite "not installed" rather than a shrug. Windows can
 * surface a child's exit code as the signed 32-bit view (`-1978335212`, what
 * PowerShell's `$LASTEXITCODE` prints) or the unsigned `GetExitCodeProcess`
 * DWORD (`2316632084`) depending on which layer reads it, so both are
 * accepted here via an unsigned-normalizing comparison.
 */
const WINGET_NO_PACKAGES_EXIT_CODE = 0x8a150014;

/**
 * Reads a `winget list` capture into an ownership verdict.
 *
 * Column headers are localized (`Nome`/`Name`, `Versão`/`Version`), so
 * "installed" is decided by exit code plus a whitespace-split token match
 * against the id itself — the one cell winget never translates — rather than
 * by anything language-specific. A superstring like `OpenJS.NodeJS.LTS`
 * never satisfies a query for `OpenJS.NodeJS`: matching is by token, not by
 * substring.
 *
 * @example
 * parseWingetListOutput(
 *   'Nome    ID                Versão  Origem\n-----\nNode.js OpenJS.NodeJS.LTS 24.19.0 winget',
 *   0,
 *   'OpenJS.NodeJS.LTS'
 * ); // 'owned'
 */
export function parseWingetListOutput(
  stdout: string,
  exitCode: number | null,
  packageId: string
): WingetOwnership {
  if (exitCode === null) return 'unknown';
  if (exitCode >>> 0 === WINGET_NO_PACKAGES_EXIT_CODE) return 'not-owned';
  if (exitCode !== 0) return 'unknown';

  const owned = stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/).includes(packageId));
  return owned ? 'owned' : 'not-owned';
}

/**
 * Marks every `system`-attributed Node installation resolved under
 * `%ProgramFiles%\nodejs` as winget-owned, once a live winget probe has
 * confirmed the package id is there.
 *
 * Only `system` is overwritten: nvm-windows can point its own `NVM_SYMLINK`
 * at the same directory, and an attribution the scanner already made from a
 * version-manager root or `BUN_INSTALL` outranks a guess from a directory
 * winget merely happens to share. Comparison is case-insensitive and
 * slash-agnostic because a realpath can come back with either separator.
 *
 * @example
 * markWingetOwnedNodeInstallations(
 *   [{ path: 'C:\\Program Files\\nodejs\\node.exe', pathSource: 'system', ... }],
 *   'C:\\Program Files'
 * ); // [{ ..., pathSource: 'winget' }]
 */
export function markWingetOwnedNodeInstallations(
  installations: readonly RuntimeInstallation[],
  programFilesDir: string | undefined
): RuntimeInstallation[] {
  const trimmedProgramFiles = programFilesDir?.trim();
  if (!trimmedProgramFiles) return [...installations];
  const nodeDir = normalizedPath(win32.join(trimmedProgramFiles, 'nodejs'));

  return installations.map((installation) => {
    if (installation.pathSource !== 'system') return installation;
    if (normalizedPath(win32.dirname(installation.path)) !== nodeDir) return installation;
    return { ...installation, pathSource: 'winget' };
  });
}
