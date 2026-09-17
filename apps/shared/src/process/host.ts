/**
 * The half of {@link ../process} that has to look at a real machine.
 *
 * Kept out of the `process` barrel on purpose: it reads PATH through
 * `Bun.which`, and the browser bundle must never resolve a module that does.
 * Same split as `@mangostudio/shared/library/host`.
 */

import type { RuntimeShellKind } from '../runtime-contract/manifest';

const executableCache = new Map<RuntimeShellKind, string | null>();

/**
 * Resolves the executable path for a shell kind, honoring platform rules.
 * PowerShell is Windows-only per product requirement; bash/zsh follow PATH.
 * The PATH lookup is memoized — shell availability is stable for a process, so
 * startup registration and per-test expectations avoid repeated `Bun.which` scans.
 *
 * @example
 * findShellExecutable('bash'); // '/usr/bin/bash' | null
 */
export function findShellExecutable(kind: RuntimeShellKind): string | null {
  const cached = executableCache.get(kind);
  if (cached !== undefined) return cached;

  const resolved = resolveShellExecutable(kind);
  executableCache.set(kind, resolved);
  return resolved;
}

/** Performs the uncached PATH lookup for a shell kind. */
function resolveShellExecutable(kind: RuntimeShellKind): string | null {
  if (kind === 'powershell') {
    if (process.platform !== 'win32') return null;
    return Bun.which('pwsh') ?? Bun.which('powershell');
  }
  return Bun.which(kind);
}

/**
 * Reports whether a shell kind can run on the current system.
 *
 * @example
 * isShellAvailable('zsh'); // false on a machine without zsh
 */
export function isShellAvailable(kind: RuntimeShellKind): boolean {
  return findShellExecutable(kind) !== null;
}
