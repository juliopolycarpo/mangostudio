import type { AgentAuthSignal } from '../schemas';

interface AuthSignalStat {
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface AuthSignalFs {
  stat(path: string): AuthSignalStat;
  readFile(path: string, maxBytes: number): string;
}

export interface AuthSignalResult {
  readonly authenticated: boolean;
  readonly authSignal: AgentAuthSignal;
}

/** True only for "the path is not there", never for permission or I/O failures. */
function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

/**
 * Reports absence only when the path is genuinely not there. A permission or
 * I/O failure hides the directory rather than proving it missing, and callers
 * turn `false` into "create it", which would be wrong advice.
 */
export function directoryExists(path: string, fs: AuthSignalFs): boolean {
  try {
    return fs.stat(path).isDirectory();
  } catch (error) {
    return !isMissingPathError(error);
  }
}

/**
 * Credential files are presence-only signals. Keep this stat-only: reading,
 * parsing, hashing, or logging their contents would turn health detection into
 * credential handling.
 */
export function probeAuthFile(
  path: string,
  options: { readonly unknownWhenMissing: boolean },
  fs: AuthSignalFs
): AuthSignalResult {
  try {
    if (fs.stat(path).isFile()) {
      return { authenticated: true, authSignal: 'file-present' };
    }
  } catch (error) {
    // Absence is handled below; a permission or I/O failure says nothing about
    // sign-in state, so it must not become a definite verdict.
    if (!isMissingPathError(error)) {
      return { authenticated: false, authSignal: 'unknown' };
    }
  }

  return {
    authenticated: false,
    authSignal: options.unknownWhenMissing ? 'unknown' : 'file-absent',
  };
}
