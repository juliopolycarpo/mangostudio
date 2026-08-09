import type { AgentAuthSignal } from '../schemas';

export const MAX_AUTH_CONFIG_BYTES = 256 * 1024;

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

/**
 * Cursor exposes sign-in state as a key in its ordinary CLI config.
 *
 * This one *reads*, unlike `probeAuthFile` above, and the policy it follows is
 * worth stating rather than implying: MangoStudio may read a bounded, non-secret
 * CLI config to test whether a key is present. It never reads, stores, logs or
 * transmits a credential value. Only the boolean below escapes this function —
 * the parsed object is unreachable the moment it returns, and no branch here
 * puts any part of it into the result, a message or a diagnostic.
 *
 * The read is bounded at `MAX_AUTH_CONFIG_BYTES` so a large or hostile file
 * cannot turn a health probe into a memory problem.
 */
export function probeConfigKey(path: string, key: string, fs: AuthSignalFs): AuthSignalResult {
  try {
    if (!fs.stat(path).isFile()) {
      return { authenticated: false, authSignal: 'config-key-absent' };
    }
  } catch (error) {
    // An absent config is a signed-out verdict; a permission or I/O failure is
    // not, so it must not be reported as a definite "not authenticated".
    return isMissingPathError(error)
      ? { authenticated: false, authSignal: 'config-key-absent' }
      : { authenticated: false, authSignal: 'unknown' };
  }

  try {
    const parsed = JSON.parse(fs.readFile(path, MAX_AUTH_CONFIG_BYTES)) as unknown;
    const authenticated =
      typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, key);
    return { authenticated, authSignal: 'config-key-present' };
  } catch {
    return { authenticated: false, authSignal: 'unknown' };
  }
}
