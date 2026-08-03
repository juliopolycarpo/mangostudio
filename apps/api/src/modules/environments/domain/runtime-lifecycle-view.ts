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
}

export function buildRuntimeLifecycleView(
  input: BuildRuntimeLifecycleViewInput
): RuntimeLifecycleView {
  const now = input.nowMs ?? Date.now();
  const readAt = input.readAtMs;
  const stale = !input.connected || readAt === null || now - readAt >= RUNTIME_HEALTH_FRESHNESS_MS;

  const actions = lifecycleActions(input.transportKind);
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

function manualCommandsFor(
  transportKind: EnvironmentTransportKind,
  platformHint?: string
): RuntimeManualCommands | undefined {
  if (transportKind !== 'websocket' && transportKind !== 'http') return undefined;

  const version = getVersion();
  if (isDevelopmentVersion(version)) {
    return {
      install: '# Build and place mangostudio-runtime on that machine from this checkout.',
      setup: 'mangostudio-runtime setup --slot remote --profile full --yes',
      serviceInstall:
        '# Service install lands separately; keep `mangostudio-runtime connect` running for now.',
    };
  }

  const platformId = platformHint && platformHint.length > 0 ? platformHint : 'linux-x64';
  const asset = `mangostudio-runtime-${version}-${platformId}`;
  const url = releaseAssetUrl(version, asset);
  return {
    install: [`curl -fsSL "${url}" -o mangostudio-runtime`, 'chmod +x mangostudio-runtime'].join(
      ' && '
    ),
    setup: './mangostudio-runtime setup --slot remote --profile full --yes',
    serviceInstall:
      '# Service install lands separately; keep `mangostudio-runtime connect` running for now.',
  };
}

/** Whether health suggests a runtime binary is already present in the slot. */
export function healthHasRuntime(health: RuntimeHealthReport | null): boolean {
  return Boolean(health?.binaryPath || health?.version);
}
