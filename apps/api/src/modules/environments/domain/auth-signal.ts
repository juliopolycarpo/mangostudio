import { statSync } from 'node:fs';
import type { AgentAuthSignal } from '@mangostudio/shared/environments';
import { readRegularFileUtf8 } from '../../../lib/safe-file';

const MAX_AUTH_CONFIG_BYTES = 256 * 1024;

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

export const NODE_AUTH_SIGNAL_FS: AuthSignalFs = {
  stat: statSync,
  readFile(path, maxBytes) {
    return readRegularFileUtf8(path, { maxBytes }).content;
  },
};

export function directoryExists(path: string, fs: AuthSignalFs = NODE_AUTH_SIGNAL_FS): boolean {
  try {
    return fs.stat(path).isDirectory();
  } catch {
    return false;
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
  fs: AuthSignalFs = NODE_AUTH_SIGNAL_FS
): AuthSignalResult {
  try {
    if (fs.stat(path).isFile()) {
      return { authenticated: true, authSignal: 'file-present' };
    }
  } catch {
    // Absence is handled below; no file contents are needed.
  }

  return {
    authenticated: false,
    authSignal: options.unknownWhenMissing ? 'unknown' : 'file-present',
  };
}

/**
 * Cursor exposes sign-in state as a key in its ordinary CLI config. Read only a
 * bounded config file and retain the key's presence, never its value.
 */
export function probeConfigKey(
  path: string,
  key: string,
  fs: AuthSignalFs = NODE_AUTH_SIGNAL_FS
): AuthSignalResult {
  try {
    if (!fs.stat(path).isFile()) {
      return { authenticated: false, authSignal: 'config-key-present' };
    }
  } catch {
    return { authenticated: false, authSignal: 'config-key-present' };
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
