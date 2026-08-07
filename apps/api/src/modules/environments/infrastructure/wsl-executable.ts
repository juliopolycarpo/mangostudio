/**
 * Resolves which `wsl.exe` the hub spawns.
 *
 * `C:\Windows\System32\wsl.exe` is a launcher stub: it reads the MSI install
 * location out of the registry and re-launches the real binary at
 * `C:\Program Files\WSL\wsl.exe` as a fresh, un-flagged process, which is what
 * flashes a console window even though every call site here already passes
 * `windowsHide`. `C:\Program Files\WSL` is not on PATH, so spawning the bare
 * name `wsl.exe` always resolves to the stub. Resolving the real binary
 * directly means the process the hub flags is the process that does the work.
 *
 * Off Windows this always answers `'wsl.exe'` / `'path'`; nothing calls it
 * there because WSL detection short-circuits on platform first.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../../../lib/config';
import { createDiagnosticLogger } from '../../../lib/logger';

export type WslExecutableSource = 'override' | 'program-files' | 'system32' | 'path';

export interface WslExecutable {
  readonly path: string;
  readonly source: WslExecutableSource;
}

const logger = createDiagnosticLogger('wsl-detection');

let cached: WslExecutable | null = null;

/**
 * Resolution order, first hit wins:
 * 1. `MANGO_WSL_EXE` — used verbatim, no existence check, so a bad override
 *    fails loudly (ENOENT on spawn) rather than silently falling back.
 * 2. `%ProgramFiles%\WSL\wsl.exe`, then `%ProgramW6432%\WSL\wsl.exe` — a
 *    32-bit host process sees the redirected view under the first variable.
 * 3. `%SystemRoot%\System32\wsl.exe` — the in-box launcher, for hosts with no
 *    MSI package installed.
 * 4. `'wsl.exe'` — PATH, last resort.
 *
 * Memoised per process: the answer cannot change while the hub is running,
 * and every WSL call site asks this on the hot connect path.
 */
export function resolveWslExecutable(): WslExecutable {
  if (cached) return cached;
  cached = resolve();
  logger.info('executable_resolved', { path: cached.path, source: cached.source });
  return cached;
}

/** Clears the memo. Tests only. */
export function resetWslExecutableCache(): void {
  cached = null;
}

function resolve(): WslExecutable {
  if (process.platform !== 'win32') return { path: 'wsl.exe', source: 'path' };

  const override = getConfig().environments.wslExecutable.trim();
  if (override) return { path: override, source: 'override' };

  for (const envVar of ['ProgramFiles', 'ProgramW6432']) {
    const programFiles = process.env[envVar];
    if (!programFiles) continue;
    const candidate = join(programFiles, 'WSL', 'wsl.exe');
    if (existsSync(candidate)) return { path: candidate, source: 'program-files' };
  }

  const systemRoot = process.env.SystemRoot;
  if (systemRoot) {
    const candidate = join(systemRoot, 'System32', 'wsl.exe');
    if (existsSync(candidate)) return { path: candidate, source: 'system32' };
  }

  return { path: 'wsl.exe', source: 'path' };
}
