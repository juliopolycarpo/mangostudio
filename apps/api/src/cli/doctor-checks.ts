/**
 * Individual diagnostic checks for the `doctor` command. Each returns a
 * CheckResult; pure functions over injected config/fs probes so they are
 * trivially testable.
 *
 * Every check is keyed: a row names its label and detail by a stable key and
 * carries the values as params, and its English `label` and `detail` are
 * rendered from the shared template for that key. The CLI prints that
 * English; the machine page renders its own language from the same keys.
 * `keyedCheck` is the only way to build a row, so a new check cannot ship as
 * English prose alone.
 */

import { dirname, join } from 'node:path';

import { type FsProbe, nearestExistingWritable } from '@mangostudio/shared/library/host';
import type { MachineCheck, MachineCheckStatus } from '@mangostudio/shared/machine';
import {
  type MachineCheckKey,
  renderMachineCheckEnglish,
} from '@mangostudio/shared/machine/check-text-en';
import { deniedCapabilities, RUNTIME_CONFIG_FILE_NAME } from '@mangostudio/shared/runtime-home';

import {
  BUILD_INFO_FILENAME,
  type BuildInfo,
  formatBuildSha,
  isKnownBuildSha,
} from '../lib/build-info';
import {
  AUTH_SECRET_MIN_LENGTH,
  getAuthSecretValidationMessage,
  isDevelopmentVersion,
  type MangoConfig,
} from '../lib/config';
import { RUNTIME_BUILD_COMMAND } from '../lib/runtime-paths';
import type { ServerState } from '../lib/server-state';
import type { RuntimeBinaryProbe } from './runtime-binary-probe';
import type { RuntimeSlotProbe } from './runtime-slot-probe';
import type { SshClientProbe } from './ssh-client-probe';

export type { FsProbe } from '@mangostudio/shared/library/host';

/** One doctor row is the shared machine check, so the API serves what the CLI prints. */
export type CheckStatus = MachineCheckStatus;
export type CheckResult = MachineCheck;

export interface BuildIdentityInput {
  serverBuild: BuildInfo | null;
  checkoutBuild: BuildInfo;
  frontendBuild: BuildInfo | null;
  frontendDir: string;
}

/** Values a keyed row's message is built from; numbers are sent as their decimal text. */
export type CheckParams = Readonly<Record<string, string | number>>;

/**
 * A keyed row. `label` and `detail` are the English of the two templates, so a
 * row cannot say something its keys do not.
 * // Usage: keyedCheck('ok', 'core.label.config', 'core.detail.configDefaults', { host, port })
 */
export function keyedCheck(
  status: CheckStatus,
  labelKey: MachineCheckKey,
  detailKey: MachineCheckKey,
  params: CheckParams = {}
): CheckResult {
  const stringParams = Object.fromEntries(
    Object.entries(params).map(([name, value]) => [name, String(value)])
  );
  const keys = { labelKey, detailKey, params: stringParams };
  // The keys are typed to exist in the English dictionary, so the draft text
  // below is never what comes back; it only satisfies the row shape.
  const { label, detail } = renderMachineCheckEnglish({
    ...keys,
    status,
    label: labelKey,
    detail: detailKey,
  });
  return { ...keys, status, label, detail };
}

/** Directory exists+writable, or is creatable because its parent is writable. */
export function checkDir(labelKey: MachineCheckKey, path: string, fs: FsProbe): CheckResult {
  const row = (status: CheckStatus, detailKey: MachineCheckKey) =>
    keyedCheck(status, labelKey, detailKey, { path });
  if (fs.exists(path)) {
    return fs.isWritable(path)
      ? row('ok', 'core.detail.directoryWritable')
      : row('fail', 'core.detail.directoryNotWritable');
  }
  return nearestExistingWritable(path, fs)
    ? row('ok', 'core.detail.directoryWillBeCreated')
    : row('fail', 'core.detail.directoryParentNotWritable');
}

export function checkConfig(config: MangoConfig): CheckResult {
  const { host, port } = config.server;
  return config.configFilePath
    ? keyedCheck('ok', 'core.label.config', 'core.detail.configFile', {
        host,
        port,
        path: config.configFilePath,
      })
    : keyedCheck('ok', 'core.label.config', 'core.detail.configDefaults', { host, port });
}

export function checkDatabase(config: MangoConfig, fs: FsProbe): CheckResult {
  if (config.database.path === ':memory:') {
    return keyedCheck('ok', 'core.label.database', 'core.detail.databaseInMemory');
  }
  const dir = dirname(config.database.path);
  return isUsableDir(dir, fs)
    ? keyedCheck('ok', 'core.label.database', 'core.detail.databasePath', {
        path: config.database.path,
      })
    : keyedCheck('fail', 'core.label.database', 'core.detail.directoryNotWritable', {
        path: dir,
      });
}

export function checkFrontend(frontendDir: string, fs: FsProbe): CheckResult {
  if (fs.exists(frontendDir) && fs.exists(join(frontendDir, 'index.html'))) {
    return keyedCheck('ok', 'core.label.frontend', 'core.detail.frontendPresent', {
      path: frontendDir,
    });
  }
  return keyedCheck('warn', 'core.label.frontend', 'core.detail.frontendMissing', {
    path: frontendDir,
  });
}

/** Frontend assets compiled into the standalone binary — always present. */
export function checkEmbeddedFrontend(fileCount: number): CheckResult {
  return keyedCheck('ok', 'core.label.frontend', 'core.detail.frontendEmbeddedFiles', {
    count: fileCount,
  });
}

/** A live instance reports the embedded sentinel while doctor runs from a source checkout. */
export function checkEmbeddedFrontendInServer(): CheckResult {
  return keyedCheck('ok', 'core.label.frontend', 'core.detail.frontendEmbeddedInServer');
}

export function checkAuthSecret(config: MangoConfig): CheckResult {
  const message = getAuthSecretValidationMessage(config.auth.secret);
  if (message) {
    // The sentence comes from config validation, which is not translated; it
    // travels as a param rather than as a key of its own.
    return keyedCheck('fail', 'core.label.authSecret', 'core.detail.authSecretInvalid', {
      message,
    });
  }
  return keyedCheck('ok', 'core.label.authSecret', 'core.detail.authSecretSet', {
    minLength: AUTH_SECRET_MIN_LENGTH,
  });
}

export function checkInstance(state: ServerState | null, alive: boolean): CheckResult {
  if (!state) {
    return keyedCheck('ok', 'core.label.instance', 'core.detail.instanceNotRunning');
  }
  if (!alive) {
    return keyedCheck('warn', 'core.label.instance', 'core.detail.instanceStale', {
      pid: state.pid,
    });
  }
  return keyedCheck('ok', 'core.label.instance', 'core.detail.instanceRunning', {
    pid: state.pid,
    port: state.port,
  });
}

export function checkRuntime(version: string, standalone: boolean): CheckResult {
  return keyedCheck(
    'ok',
    'core.label.runtime',
    standalone ? 'core.detail.runtimeStandalone' : 'core.detail.runtimeDevelopment',
    { version, platform: process.platform, arch: process.arch }
  );
}

/**
 * Reports the runtime binary the hub launches for Local — and for a stdio
 * environment with no binary path of its own. A missing one is a failure: the
 * hub has no other runtime, so without it Local cannot start. A release drift
 * is only a warning, and a development hub has no release to drift from.
 */
export function checkRuntimeBinary(probe: RuntimeBinaryProbe, hubVersion: string): CheckResult {
  if (!probe.path) {
    return keyedCheck('fail', 'core.label.runtimeBinary', 'core.detail.runtimeBinaryNotBuilt', {
      command: RUNTIME_BUILD_COMMAND,
    });
  }
  if (!probe.present) {
    return keyedCheck('fail', 'core.label.runtimeBinary', 'core.detail.runtimeBinaryMissing', {
      path: probe.path,
    });
  }
  if (probe.error || !probe.version) {
    return probe.error
      ? keyedCheck('warn', 'core.label.runtimeBinary', 'core.detail.runtimeBinaryNoVersion', {
          path: probe.path,
          reason: probe.error,
        })
      : keyedCheck(
          'warn',
          'core.label.runtimeBinary',
          'core.detail.runtimeBinaryNoVersionUnknown',
          { path: probe.path }
        );
  }
  if (!isDevelopmentVersion(hubVersion) && probe.version !== hubVersion) {
    return keyedCheck('warn', 'core.label.runtimeBinary', 'core.detail.runtimeBinaryMismatch', {
      version: probe.version,
      hubVersion,
    });
  }
  return keyedCheck('ok', 'core.label.runtimeBinary', 'core.detail.runtimeBinaryOk', {
    version: probe.version,
    path: probe.path,
  });
}

/**
 * One row per slot in the runtime home, saying what that machine has agreed a
 * hub may do there.
 *
 * A slot still waiting for `setup` is a warning rather than a failure: the hub
 * runs fine, the runtime in that slot simply refuses to serve until somebody at
 * the machine answers. Everything else about it — that it is installed, that it
 * is reachable — is true and unhelpful without this line.
 */
export function checkRuntimeSlot(probe: RuntimeSlotProbe): CheckResult {
  const slot = probe.slot;
  // Named, because `setup` run without it answers for the slot the binary sits
  // in — which is not the slot this row is about unless they happen to agree.
  const command = `mangostudio-runtime setup --slot ${slot}`;
  if (probe.error) {
    return keyedCheck('fail', 'core.label.runtimeSlot', 'core.detail.runtimeSlotUnreadable', {
      slot,
      file: RUNTIME_CONFIG_FILE_NAME,
      directory: probe.directory,
      error: probe.error,
      command,
    });
  }
  if (probe.config.setup.state === 'pending') {
    return keyedCheck('warn', 'core.label.runtimeSlot', 'core.detail.runtimeSlotPending', {
      slot,
      command,
    });
  }
  const { version, profile } = probe.config;
  const denied = deniedCapabilities(probe.config.allow);
  const detailKey: MachineCheckKey =
    denied.length > 0
      ? version
        ? 'core.detail.runtimeSlotDeniedVersion'
        : 'core.detail.runtimeSlotDenied'
      : version
        ? 'core.detail.runtimeSlotConfiguredVersion'
        : 'core.detail.runtimeSlotConfigured';
  return keyedCheck('ok', 'core.label.runtimeSlot', detailKey, {
    slot,
    profile,
    directory: probe.directory,
    ...(version ? { version } : {}),
    ...(denied.length > 0 ? { denied: denied.join(', ') } : {}),
  });
}

/**
 * Hub-side cache of release runtime assets under `~/.mango/runtime-cache/`.
 * Presence is informational; prune keeps current + previous after each push.
 */
export function checkRuntimeCache(input: {
  readonly directory: string;
  readonly versions: readonly string[];
}): CheckResult {
  if (input.versions.length === 0) {
    return keyedCheck('ok', 'core.label.runtimeCache', 'core.detail.runtimeCacheEmpty', {
      directory: input.directory,
    });
  }
  return keyedCheck('ok', 'core.label.runtimeCache', 'core.detail.runtimeCacheVersions', {
    versions: input.versions.join(', '),
    directory: input.directory,
  });
}

/**
 * A warning like the runtime binary above, and for the same reason: a hub with
 * no ssh client serves every other environment normally, it just cannot launch
 * an SSH one. Reported even where OpenSSH is usually present, because the case
 * this exists for — a Windows host that never enabled the optional feature —
 * looks identical from the outside until an environment refuses to connect.
 */
export function checkSshClient(probe: SshClientProbe): CheckResult {
  if (!probe.path) {
    return keyedCheck('warn', 'core.label.sshClient', 'core.detail.sshClientMissing');
  }
  if (probe.error || !probe.version) {
    return probe.error
      ? keyedCheck('warn', 'core.label.sshClient', 'core.detail.sshClientNoVersion', {
          path: probe.path,
          reason: probe.error,
        })
      : keyedCheck('warn', 'core.label.sshClient', 'core.detail.sshClientNoVersionUnknown', {
          path: probe.path,
        });
  }
  return keyedCheck('ok', 'core.label.sshClient', 'core.detail.sshClientOk', {
    version: probe.version,
    path: probe.path,
  });
}

/** The `ok` row for a build stamp: its SHA, when it was built, and whether the tree was dirty. */
function buildStampCheck(labelKey: MachineCheckKey, build: BuildInfo): CheckResult {
  const detailKey: MachineCheckKey =
    build.gitDirty === true
      ? 'core.detail.buildStampDirty'
      : build.gitDirty === false
        ? 'core.detail.buildStampClean'
        : 'core.detail.buildStampDirtyUnknown';
  return keyedCheck('ok', labelKey, detailKey, {
    sha: formatBuildSha(build),
    builtAt: build.builtAt,
    buildType: build.buildType,
  });
}

export function collectBuildIdentityChecks(input: BuildIdentityInput): CheckResult[] {
  const results: CheckResult[] = [
    input.serverBuild
      ? buildStampCheck('core.label.serverBuild', input.serverBuild)
      : keyedCheck('warn', 'core.label.serverBuild', 'core.detail.serverBuildMissing'),
  ];

  if (buildsDiffer(input.serverBuild, input.checkoutBuild)) {
    results.push(
      keyedCheck('warn', 'core.label.checkoutBuild', 'core.detail.checkoutBuildDiffers', {
        checkout: formatBuildSha(input.checkoutBuild),
        server: formatBuildSha(input.serverBuild),
      })
    );
  } else {
    results.push(buildStampCheck('core.label.checkoutBuild', input.checkoutBuild));
  }

  if (!input.frontendBuild) {
    results.push(
      keyedCheck('warn', 'core.label.frontendBuild', 'core.detail.frontendBuildMissing', {
        path: join(input.frontendDir, BUILD_INFO_FILENAME),
      })
    );
  } else if (buildsDiffer(input.serverBuild, input.frontendBuild)) {
    results.push(
      keyedCheck('warn', 'core.label.frontendBuild', 'core.detail.frontendBuildDiffers', {
        frontend: formatBuildSha(input.frontendBuild),
        server: formatBuildSha(input.serverBuild),
      })
    );
  } else {
    results.push(buildStampCheck('core.label.frontendBuild', input.frontendBuild));
  }

  return results;
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
