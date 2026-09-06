/**
 * Whether `serve` should retry a pending prune on start. `install-origin.json`
 * carries `prunePending` forward across installs (see `InstallOriginRecord`)
 * for exactly one reason today: `install.ps1 -Prune` cannot delete a version
 * directory that is still the running exe, and records it to retry once the
 * process holding it has moved on. POSIX prunes never leave one behind — the
 * old binary is unlinked, not locked — so this only ever fires on Windows.
 */

export interface PruneRetryInput {
  readonly platform: NodeJS.Platform;
  readonly prunePending: readonly string[] | undefined;
}

/** // Usage: shouldRetryPrune({ platform: 'win32', prunePending: ['0.4.0'] }) */
export function shouldRetryPrune(input: PruneRetryInput): boolean {
  return input.platform === 'win32' && (input.prunePending?.length ?? 0) > 0;
}
