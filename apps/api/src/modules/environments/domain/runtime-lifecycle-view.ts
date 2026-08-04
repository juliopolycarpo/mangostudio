/**
 * Builds the runtime lifecycle view the environment card reads.
 *
 * Action availability is decided here, not in the browser: a button the hub
 * cannot honour must never render, because dial-in machines are unreachable
 * before pairing and local/in-process installs ship with the hub itself.
 */

import type {
  EnvironmentTransportKind,
  RuntimeLifecycleAction,
  RuntimeLifecycleView,
  RuntimeManualCommands,
} from '@mangostudio/shared/environments';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import { getVersion, isDevelopmentVersion } from '../../../lib/config';
import { releaseAssetUrl } from './wsl-runtime-release';

/** Matches the connection manager's manifest freshness window. */
const RUNTIME_HEALTH_FRESHNESS_MS = 15_000;

export interface BuildRuntimeLifecycleViewInput {
  readonly transportKind: EnvironmentTransportKind;
  readonly health: RuntimeHealthReport | null;
  readonly readAtMs: number | null;
  readonly connected: boolean;
  readonly nowMs?: number;
  readonly slotBytes?: number | null;
  /** Platform id for copyable install URLs (websocket/http). */
  readonly platformHint?: string;
  /**
   * When false, omit hub-managed install/reinstall/upgrade (e.g. SSH with a
   * custom `remoteRuntimePath` the push helper cannot target).
   */
  readonly managedPush?: boolean;
}

export function buildRuntimeLifecycleView(
  input: BuildRuntimeLifecycleViewInput
): RuntimeLifecycleView {
  const now = input.nowMs ?? Date.now();
  const readAt = input.readAtMs;
  const stale = !input.connected || readAt === null || now - readAt >= RUNTIME_HEALTH_FRESHNESS_MS;

  const baseActions = lifecycleActions(input.transportKind);
  const actions = filterLifecycleActions(
    canUpdateOverLiveConnection(input)
      ? [...new Set<RuntimeLifecycleAction>([...baseActions, 'upgrade'])]
      : baseActions,
    input.health,
    input.managedPush !== false
  );
  const manualCommands = manualCommandsFor(input.transportKind, input.platformHint);

  return {
    health: input.health,
    readAt,
    stale,
    slotBytes: input.slotBytes ?? null,
    actions,
    ...(manualCommands ? { manualCommands } : {}),
  };
}

export function canUpdateOverLiveConnection(
  input: Pick<
    BuildRuntimeLifecycleViewInput,
    'transportKind' | 'health' | 'connected' | 'managedPush'
  >
): boolean {
  return (
    input.transportKind !== 'in-process' &&
    input.transportKind !== 'wsl' &&
    input.transportKind !== 'ssh' &&
    input.connected &&
    input.managedPush !== false &&
    input.health !== null &&
    input.health.source === 'provisioned' &&
    input.health.platformId !== undefined &&
    input.health.platform !== 'win32' &&
    input.health.runtimeVersion !== getVersion()
  );
}

/**
 * Hub-reachable transports get push/setup actions; dial-in and local surfaces
 * report status only (plus copyable commands for websocket/http).
 */
export function lifecycleActions(
  transportKind: EnvironmentTransportKind
): readonly RuntimeLifecycleAction[] {
  switch (transportKind) {
    case 'wsl':
      return ['install', 'reinstall', 'upgrade'];
    case 'ssh':
      return ['install', 'reinstall', 'upgrade', 'setup'];
    case 'websocket':
    case 'http':
    case 'in-process':
    case 'stdio':
      return [];
    default: {
      const _exhaustive: never = transportKind;
      return _exhaustive;
    }
  }
}

/** Actions that put new runtime bytes on the target machine. */
const PUSH_ACTIONS: readonly RuntimeLifecycleAction[] = ['install', 'reinstall', 'upgrade'];

/**
 * Apply consent and push-target gates on top of the transport action matrix.
 *
 * `allow.update === false` hides **every** push action, `install` included.
 * All three run the same helper and write the same bytes, so gating only
 * upgrade/reinstall would leave the machine's answer one button-click wide —
 * and this gate is the only enforcement there is: the push travels over the
 * user's own ssh/wsl credentials, out of band, where the runtime cannot refuse
 * it the way {@link consent-gate} refuses a protocol call. A non-managed push
 * target hides the same three but keeps setup when the transport allows it.
 */
function filterLifecycleActions(
  actions: readonly RuntimeLifecycleAction[],
  health: RuntimeHealthReport | null,
  managedPush: boolean
): readonly RuntimeLifecycleAction[] {
  let next = actions;
  if (!managedPush) {
    next = next.filter((action) => action === 'setup');
  }
  if (health?.allow?.update === false) {
    next = next.filter((action) => !PUSH_ACTIONS.includes(action));
  }
  return next;
}

/**
 * Maps a health-style `platform-arch` hint (Node's `win32`, …) to a release
 * platform id (`windows-x64`, `linux-x64-musl`, …).
 */
export function releasePlatformIdFromHint(platformHint: string): string {
  const hint = platformHint.trim().toLowerCase();
  if (hint.startsWith('win32-')) return `windows-${hint.slice('win32-'.length)}`;
  return hint;
}

/**
 * Raw runtime asset basename published for a release platform id — mirrors
 * `releaseRawRuntimeBinaryFileName` (`.exe` on Windows).
 */
export function manualRuntimeReleaseAssetName(version: string, platformHint: string): string {
  const platformId = releasePlatformIdFromHint(platformHint);
  const suffix = platformId.startsWith('windows-') ? '.exe' : '';
  return `mangostudio-runtime-${version}-${platformId}${suffix}`;
}

/** Fallback when no peer has ever reported a platform. Always marked as assumed. */
const ASSUMED_PLATFORM_HINT = 'linux-x64';

function manualCommandsFor(
  transportKind: EnvironmentTransportKind,
  platformHint?: string
): RuntimeManualCommands | undefined {
  if (transportKind !== 'websocket' && transportKind !== 'http') return undefined;

  const reported = platformHint !== undefined && platformHint.length > 0;
  const hint = reported ? platformHint : ASSUMED_PLATFORM_HINT;
  const platformId = releasePlatformIdFromHint(hint);
  const isWindows = platformId.startsWith('windows-');
  const localName = isWindows ? 'mangostudio-runtime.exe' : 'mangostudio-runtime';
  const identity = { platformId, platformAssumed: !reported } as const;

  const version = getVersion();
  if (isDevelopmentVersion(version)) {
    return {
      ...identity,
      install: '# Build and place mangostudio-runtime on that machine from this checkout.',
      setup: 'mangostudio-runtime setup --slot remote --profile full --yes',
      serviceInstall:
        '# Service install lands separately; keep `mangostudio-runtime connect` running for now.',
    };
  }

  const asset = manualRuntimeReleaseAssetName(version, hint);
  const url = releaseAssetUrl(version, asset);
  const sumsUrl = releaseAssetUrl(version, 'SHA256SUMS');

  // A one-liner that downloads an executable and chmods it without checking the
  // release checksum is the one shape this must not ship. Posix chains the three
  // steps; PowerShell cannot chain the same way, so Windows gets a second line
  // rather than a silently weaker command.
  const install = isWindows
    ? `curl.exe -fsSL "${url}" -o ${localName}`
    : [
        `curl -fsSL "${url}" -o ${localName}`,
        `curl -fsSL "${sumsUrl}" | awk '$2=="${asset}"{print $1"  ${localName}"}' | sha256sum -c -`,
        `chmod +x ${localName}`,
      ].join(' && ');
  const verify = isWindows
    ? `curl.exe -fsSL "${sumsUrl}" -o SHA256SUMS; ` +
      `$want = (Select-String -Path SHA256SUMS -Pattern ' ${asset}$').Line.Split(' ')[0]; ` +
      `if ((Get-FileHash .\\${localName} -Algorithm SHA256).Hash -ne $want) { throw 'checksum mismatch' }`
    : undefined;

  return {
    ...identity,
    install,
    ...(verify ? { verify } : {}),
    setup: isWindows
      ? `.\\${localName} setup --slot remote --profile full --yes`
      : `./${localName} setup --slot remote --profile full --yes`,
    serviceInstall:
      '# Service install lands separately; keep `mangostudio-runtime connect` running for now.',
  };
}
