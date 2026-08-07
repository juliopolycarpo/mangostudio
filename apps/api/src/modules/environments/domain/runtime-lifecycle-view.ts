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
  RuntimeStagedAsset,
} from '@mangostudio/shared/environments';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import { getVersion, isDevelopmentVersion } from '../../../lib/config';
import { resolveRuntimeRelease } from './runtime-release-resolution';
import { releaseArchiveName, releaseAssetUrl } from './wsl-runtime-release';

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
  /**
   * The runtime this hub would install, and whether a verified copy is already
   * in its cache. Resolved by the caller because "is it on disk" is a question
   * only the filesystem can answer, and this builder stays pure.
   */
  readonly stagedRuntime?: RuntimeStagedAsset | undefined;
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
    input.managedPush !== false,
    input.stagedRuntime !== undefined
  );
  const manualCommands = manualCommandsFor(input.transportKind, input.platformHint);

  return {
    health: input.health,
    readAt,
    stale,
    slotBytes: input.slotBytes ?? null,
    actions,
    ...(manualCommands ? { manualCommands } : {}),
    ...(input.stagedRuntime ? { stagedRuntime: input.stagedRuntime } : {}),
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
    // The container's binary is a read-only bind mount of the hub's own, so a
    // live update has nothing to write to and nothing to fix: relaunching the
    // container already picks up whatever version this hub now resolves.
    input.transportKind !== 'container' &&
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
      return ['install', 'reinstall', 'upgrade', 'download'];
    case 'ssh':
      return ['install', 'reinstall', 'upgrade', 'setup', 'download'];
    // A container mounts the hub's own runtime binary read-only, so there is
    // nothing to install, upgrade or consent to on the far side: the bytes
    // follow this hub's version by construction, and the slot they resolve to
    // is `host`, which is already answered.
    case 'container':
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
 *
 * `download` survives both gates. It writes to the hub and nowhere else, so
 * neither a machine that refuses hub-driven updates nor a custom runtime path
 * the push helper cannot target is a reason to withhold it — those are exactly
 * the cases where somebody has to carry the verified bytes over by hand.
 *
 * `canStage` is the one gate `download` does not survive: a machine that has
 * never reported a platform (or a source-checkout hub with no release to
 * fetch) gives `stagedRuntimeAssetFor` nothing to name, and the card would
 * offer a button that rejects the click with "connect it once" the instant
 * somebody presses it.
 */
function filterLifecycleActions(
  actions: readonly RuntimeLifecycleAction[],
  health: RuntimeHealthReport | null,
  managedPush: boolean,
  canStage: boolean
): readonly RuntimeLifecycleAction[] {
  let next = actions;
  if (!managedPush) {
    next = next.filter((action) => action === 'setup' || action === 'download');
  }
  if (health?.allow?.update === false) {
    next = next.filter((action) => !PUSH_ACTIONS.includes(action));
  }
  if (!canStage) {
    next = next.filter((action) => action !== 'download');
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
 *
 * Resolved through the channel, not spliced from the running version: on a
 * rolling channel the asset is named for the tag it lives under, so a canary
 * hub that pasted its own `<root>-canary.<sha7>` in here would hand somebody a
 * command that 404s.
 */
export function manualRuntimeReleaseAssetName(version: string, platformHint: string): string {
  return resolveRuntimeRelease(version, releasePlatformIdFromHint(platformHint)).runtimeAssetName;
}

/**
 * Describes the runtime this hub would install and where a staged copy lives.
 *
 * Returns undefined when the hub cannot name one asset: a source checkout
 * publishes no release, and a machine that has never reported a platform would
 * only get a guess — and a guess is fine for a copyable command somebody reads
 * before running, but not for a path this card claims already holds bytes.
 */
export function stagedRuntimeAsset(input: {
  readonly version: string;
  readonly platformHint: string | undefined;
  readonly cacheDir: (version: string) => string;
  readonly present: boolean;
  /**
   * Names the platform archive instead of the standalone runtime — the asset
   * that is actually on disk when a release publishes no raw runtime for this
   * platform and the download fell back to it. Naming the raw asset anyway
   * would describe a file that is not there and a checksum line that cannot
   * pass.
   */
  readonly fromArchive?: boolean;
  /**
   * The hub's own OS, for a path and a verify command it can actually run.
   * Defaults to the running process's — a parameter only so tests can cover
   * both hosts without one physically existing.
   */
  readonly hostPlatform?: string;
  /**
   * The digest recorded next to the cached file at download time (see
   * {@link runtimeDigestSidecarPath}). When present, the verify command checks
   * the file against this pinned value instead of re-fetching SHA256SUMS —
   * the fetch is what a rolling tag can outrun between download and view.
   */
  readonly pinnedDigest?: string;
}): RuntimeStagedAsset | undefined {
  if (isDevelopmentVersion(input.version)) return undefined;
  if (input.platformHint === undefined || input.platformHint.length === 0) return undefined;

  const platformId = releasePlatformIdFromHint(input.platformHint);
  const release = resolveRuntimeRelease(input.version, platformId);
  const assetName = input.fromArchive
    ? releaseArchiveName(release.assetVersion, platformId)
    : release.runtimeAssetName;
  // `cacheDir()` returns a host-native path (backslashes on a Windows hub);
  // joining onto it with the wrong separator produces a mixed path that
  // Explorer, cmd, and some tools reject.
  const hostIsWindows = (input.hostPlatform ?? process.platform) === 'win32';
  const path = hostIsWindows
    ? joinWin32(input.cacheDir(input.version), assetName)
    : joinPosix(input.cacheDir(input.version), assetName);
  const sumsUrl = releaseAssetUrl(release.tagVersion, 'SHA256SUMS');

  return {
    version: input.version,
    platformId,
    assetName,
    path,
    // `curl | awk | sha256sum` needs a POSIX shell and GNU coreutils, neither
    // of which a stock Windows hub has; it gets the same PowerShell shape
    // {@link manualCommandsFor} already hands a Windows target below.
    verify: input.pinnedDigest
      ? hostIsWindows
        ? `if ((Get-FileHash "${path}" -Algorithm SHA256).Hash -ne "${input.pinnedDigest}") { throw 'checksum mismatch' } else { 'OK' }`
        : `echo "${input.pinnedDigest}  ${path}" | sha256sum -c -`
      : hostIsWindows
        ? `curl.exe -fsSL "${sumsUrl}" -o SHA256SUMS; ` +
          `$want = (Select-String -Path SHA256SUMS -Pattern ' ${assetName}$').Line.Split(' ')[0]; ` +
          `if ((Get-FileHash "${path}" -Algorithm SHA256).Hash -ne $want) { throw 'checksum mismatch' } else { 'OK' }`
        : // Checks the file where it actually is, against the release that
          // published it. `sha256sum -c` needs "<digest>  <path>", and the
          // published line names the asset, not this cache path — so the path
          // is substituted in.
          `curl -fsSL "${sumsUrl}" | awk '$2=="${assetName}"{print $1"  ${path}"}' | sha256sum -c -`,
    present: input.present,
  };
}

/** Cache paths are hub-local and posix-shaped everywhere but a Windows hub. */
function joinPosix(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function joinWin32(dir: string, name: string): string {
  return dir.endsWith('\\') ? `${dir}${name}` : `${dir}\\${name}`;
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
      serviceInstall: isWindows
        ? undefined
        : transportKind === 'http'
          ? 'mangostudio-runtime service install --mode serve'
          : 'mangostudio-runtime service install --mode connect',
    };
  }

  const release = resolveRuntimeRelease(version, platformId);
  const asset = release.runtimeAssetName;
  const url = releaseAssetUrl(release.tagVersion, asset);
  const sumsUrl = releaseAssetUrl(release.tagVersion, 'SHA256SUMS');

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
    serviceInstall: isWindows
      ? undefined
      : transportKind === 'http'
        ? `./${localName} service install --mode serve`
        : `./${localName} service install --mode connect`,
  };
}
