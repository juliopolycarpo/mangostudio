/**
 * Individual diagnostic checks for the `doctor` command. Each returns a
 * CheckResult; pure functions over injected config/fs probes so they are
 * trivially testable.
 */

import { dirname, join } from 'node:path';
import {
  BUILD_INFO_FILENAME,
  type BuildInfo,
  formatBuildInfo,
  formatBuildSha,
  isKnownBuildSha,
} from '../lib/build-info';
import {
  AUTH_SECRET_MIN_LENGTH,
  getAuthSecretValidationMessage,
  type MangoConfig,
} from '../lib/config';
import type { ServerState } from '../lib/server-state';
import type { CursorRuntimeChainStep } from '../services/providers/cursor/runtime-availability';

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

export interface BuildIdentityInput {
  serverBuild: BuildInfo | null;
  checkoutBuild: BuildInfo;
  frontendBuild: BuildInfo | null;
  frontendDir: string;
}

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
  return nearestExistingWritable(path, fs)
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
  const message = getAuthSecretValidationMessage(config.auth.secret);
  if (message) {
    return fail('Auth secret', message);
  }
  return ok('Auth secret', `set (${AUTH_SECRET_MIN_LENGTH}+ characters)`);
}

export function checkInstance(state: ServerState | null, alive: boolean): CheckResult {
  if (!state) {
    return ok('Instance', 'not running');
  }
  if (!alive) {
    return warn('Instance', `stale state file (PID ${state.pid})`);
  }
  return ok('Instance', `running (PID ${state.pid}, port ${state.port}, health not probed)`);
}

export function checkRuntime(version: string, standalone: boolean): CheckResult {
  return ok(
    'Runtime',
    `v${version} ${process.platform}-${process.arch} ${standalone ? 'standalone' : 'dev'}`
  );
}

export function collectBuildIdentityChecks(input: BuildIdentityInput): CheckResult[] {
  const results: CheckResult[] = [
    input.serverBuild
      ? ok('Server build', formatBuildInfo(input.serverBuild))
      : warn('Server build', 'running server did not report build metadata'),
  ];

  if (buildsDiffer(input.serverBuild, input.checkoutBuild)) {
    results.push(
      warn(
        'Checkout build',
        `checkout ${formatBuildSha(input.checkoutBuild)} differs from server ${formatBuildSha(input.serverBuild)}; restart or rebuild if unexpected`
      )
    );
  } else {
    results.push(ok('Checkout build', formatBuildInfo(input.checkoutBuild)));
  }

  if (!input.frontendBuild) {
    results.push(
      warn(
        'Frontend build',
        `${join(input.frontendDir, BUILD_INFO_FILENAME)} missing; rebuild frontend assets to compare`
      )
    );
  } else if (buildsDiffer(input.serverBuild, input.frontendBuild)) {
    results.push(
      warn(
        'Frontend build',
        `frontend ${formatBuildSha(input.frontendBuild)} differs from server ${formatBuildSha(input.serverBuild)}`
      )
    );
  } else {
    results.push(ok('Frontend build', formatBuildInfo(input.frontendBuild)));
  }

  return results;
}

const CURSOR_CHAIN_LABELS: Record<CursorRuntimeChainStep['link'], string> = {
  node: 'Cursor Node',
  sidecar: 'Cursor sidecar',
  sdk: 'Cursor SDK',
  native: 'Cursor native',
};

export interface CursorDoctorProbeResult {
  ok: boolean;
  detail: string;
}

/** Map per-link Cursor runtime chain steps into doctor checklist rows. */
export function collectCursorDoctorChecks(
  steps: readonly CursorRuntimeChainStep[],
  probe?: CursorDoctorProbeResult
): CheckResult[] {
  const results = steps.map((step) => {
    const label = CURSOR_CHAIN_LABELS[step.link];
    return step.ok ? ok(label, step.detail) : fail(label, step.detail);
  });

  if (probe) {
    results.push(probe.ok ? ok('Cursor probe', probe.detail) : fail('Cursor probe', probe.detail));
  }

  return results;
}

/** True when every prerequisite chain link passed (probe may still be pending). */
export function cursorRuntimeChainReady(steps: readonly CursorRuntimeChainStep[]): boolean {
  return steps.every((step) => step.ok);
}

function buildsDiffer(
  left: BuildInfo | null | undefined,
  right: BuildInfo | null | undefined
): boolean {
  return isKnownBuildSha(left) && isKnownBuildSha(right) && left.gitSha !== right.gitSha;
}

function isUsableDir(path: string, fs: FsProbe): boolean {
  return fs.exists(path) ? fs.isWritable(path) : nearestExistingWritable(path, fs);
}

/**
 * Whether a not-yet-created path can be made: walk up to the nearest existing
 * ancestor and check that it is writable. Handles fresh installs where several
 * directory levels (e.g. ~/.mango/logs) do not exist yet.
 */
function nearestExistingWritable(path: string, fs: FsProbe): boolean {
  let current = dirname(path);
  while (!fs.exists(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return false; // reached the filesystem root without finding anything
    }
    current = parent;
  }
  return fs.isWritable(current);
}
