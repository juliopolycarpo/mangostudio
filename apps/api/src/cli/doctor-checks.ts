/**
 * Individual diagnostic checks for the `doctor` command. Each returns a
 * CheckResult; pure functions over injected config/fs probes so they are
 * trivially testable.
 */

import { dirname, join } from 'node:path';
import type { MangoConfig } from '../lib/config';
import type { ServerState } from '../lib/server-state';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  label: string;
  status: CheckStatus;
  detail: string;
}

/** Filesystem probe seam so checks run without touching the real disk in tests. */
export interface FsProbe {
  exists(path: string): boolean;
  isWritable(path: string): boolean;
}

const MIN_SECRET_LENGTH = 32;

export function ok(label: string, detail: string): CheckResult {
  return { label, status: 'ok', detail };
}

export function warn(label: string, detail: string): CheckResult {
  return { label, status: 'warn', detail };
}

export function fail(label: string, detail: string): CheckResult {
  return { label, status: 'fail', detail };
}

/** Directory exists+writable, or is creatable because its parent is writable. */
export function checkDir(label: string, path: string, fs: FsProbe): CheckResult {
  if (fs.exists(path)) {
    return fs.isWritable(path)
      ? ok(label, `${path} (writable)`)
      : fail(label, `${path} (not writable)`);
  }
  return fs.isWritable(dirname(path))
    ? ok(label, `${path} (will be created)`)
    : fail(label, `${path} (parent not writable)`);
}

export function checkConfig(config: MangoConfig): CheckResult {
  return ok(
    'Config',
    `${config.server.host}:${config.server.port} (${config.configFilePath || 'defaults'})`
  );
}

export function checkDatabase(config: MangoConfig, fs: FsProbe): CheckResult {
  if (config.database.path === ':memory:') {
    return ok('Database', 'in-memory');
  }
  const dir = dirname(config.database.path);
  return isUsableDir(dir, fs)
    ? ok('Database', config.database.path)
    : fail('Database', `${dir} (not writable)`);
}

export function checkFrontend(frontendDir: string, fs: FsProbe): CheckResult {
  if (fs.exists(frontendDir) && fs.exists(join(frontendDir, 'index.html'))) {
    return ok('Frontend', `${frontendDir} (present)`);
  }
  return warn('Frontend', `${frontendDir} (missing — API only)`);
}

export function checkAuthSecret(config: MangoConfig): CheckResult {
  if (!config.auth.secret) {
    return warn('Auth secret', 'BETTER_AUTH_SECRET not set');
  }
  if (config.auth.secret.length < MIN_SECRET_LENGTH) {
    return warn('Auth secret', `shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  return ok('Auth secret', 'set');
}

export function checkInstance(
  state: ServerState | null,
  alive: boolean,
  healthy: boolean
): CheckResult {
  if (!state) {
    return ok('Instance', 'not running');
  }
  if (!alive) {
    return warn('Instance', `stale state file (PID ${state.pid})`);
  }
  return ok(
    'Instance',
    `running (PID ${state.pid}, port ${state.port}, health ${healthy ? 'ok' : 'unreachable'})`
  );
}

export function checkRuntime(version: string, standalone: boolean): CheckResult {
  return ok(
    'Runtime',
    `v${version} ${process.platform}-${process.arch} ${standalone ? 'standalone' : 'dev'}`
  );
}

function isUsableDir(path: string, fs: FsProbe): boolean {
  return fs.exists(path) ? fs.isWritable(path) : fs.isWritable(dirname(path));
}
