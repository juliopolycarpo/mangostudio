/**
 * Toolchain, version-manager and agent-CLI detection, executed on the machine
 * the answers describe.
 *
 * Every status shape here is the one the hub already published; only the host
 * changed. What did *not* move is policy: whether a recipe exists for an id,
 * which Node releases are current, and how long a status stays fresh are all
 * hub decisions, and they arrive as parameters rather than being re-derived
 * from whatever this machine happens to have lying around.
 */

import { posix, win32 } from 'node:path';
import type {
  AgentCliStatus,
  RuntimeFinding,
  RuntimeHealth,
  RuntimeStatus,
  VersionManagerId,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import {
  AGENT_CLI_DEFINITIONS,
  type AgentCliDefinition,
  type AuthSignalFs,
  analyzeRuntimeScan,
  type BinaryScanDeps,
  BUN_RUNTIME_DEFINITION,
  detectFnm,
  detectNvm,
  directoryExists,
  type ExternalAgentCliDefinition,
  FNM_RUNTIME_DEFINITION,
  type FnmDetectionDeps,
  GIT_RUNTIME_DEFINITION,
  markWingetOwnedNodeInstallations,
  NODE_LTS_WINGET_PACKAGE_ID,
  NODE_RELEASE_SCHEDULE,
  NODE_RUNTIME_DEFINITION,
  type NvmDetectionDeps,
  probeAuthFile,
  probeConfigKey,
  type RuntimeDefinition,
  type RuntimeScanResult,
  scanRuntime,
  WINGET_RUNTIME_DEFINITION,
  type WingetOwnership,
} from '@mangostudio/shared/environments/detection';
import type { LibraryLocationStatus, LibraryTargetId } from '@mangostudio/shared/library';
import { describeTargetLocations, getLibraryTarget } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { RuntimeToolArgumentError } from '../../errors';
import type {
  RuntimeProbeAgentClisParams,
  RuntimeProbeAgentClisResult,
  RuntimeProbeBudget,
  RuntimeProbeRuntimesParams,
  RuntimeProbeRuntimesResult,
  RuntimeProbeVersionManagersParams,
  RuntimeProbeVersionManagersResult,
} from '../../methods';
import { throwIfAborted } from '../cancellation';
import {
  createBinaryScanDeps,
  createFnmDetectionDeps,
  createNvmDetectionDeps,
  createRuntimePathEnv,
  NODE_AUTH_SIGNAL_FS,
  NODE_LOCATION_FS_PROBE,
  probeWingetOwnership,
} from './host-env';

/**
 * Every way this service touches the machine. Bound to Node by default; a test
 * — or a host that is not a filesystem at all — swaps the whole set rather than
 * monkey-patching the module.
 */
export interface ProbingHostAdapters {
  readonly createPathEnv: (overrides?: {
    readonly env?: Readonly<Record<string, string>>;
  }) => PathEnv;
  readonly createScanDeps: (
    env: PathEnv,
    definition: RuntimeDefinition,
    budget?: RuntimeProbeBudget,
    signal?: AbortSignal
  ) => BinaryScanDeps;
  readonly createNvmDeps: (env: PathEnv) => NvmDetectionDeps;
  readonly createFnmDeps: (env: PathEnv) => FnmDetectionDeps;
  readonly authFs: AuthSignalFs;
  readonly describeLocations: (targetId: LibraryTargetId, env: PathEnv) => LibraryLocationStatus[];
  readonly runtimeDefinitions: readonly RuntimeDefinition[];
  readonly agentDefinitions: readonly AgentCliDefinition[];
  readonly now: () => number;
  readonly selfExecutablePath: () => string;
  /**
   * Whether winget owns a package id, asked once per `probeRuntimes` call on
   * win32 when Node is among the ids probed. Optional because every other
   * platform has nothing to bind it to; {@link DEFAULT_ADAPTERS} always
   * provides one, so only a test overriding the whole adapter set needs to
   * think about its absence.
   */
  readonly wingetOwnership?: (packageId: string, signal?: AbortSignal) => Promise<WingetOwnership>;
}

const DEFAULT_ADAPTERS: ProbingHostAdapters = {
  createPathEnv: createRuntimePathEnv,
  createScanDeps: createBinaryScanDeps,
  createNvmDeps: createNvmDetectionDeps,
  createFnmDeps: createFnmDetectionDeps,
  authFs: NODE_AUTH_SIGNAL_FS,
  describeLocations: (targetId, env) =>
    describeTargetLocations(targetId, env, NODE_LOCATION_FS_PROBE),
  runtimeDefinitions: [
    BUN_RUNTIME_DEFINITION,
    NODE_RUNTIME_DEFINITION,
    FNM_RUNTIME_DEFINITION,
    GIT_RUNTIME_DEFINITION,
    WINGET_RUNTIME_DEFINITION,
  ],
  agentDefinitions: AGENT_CLI_DEFINITIONS,
  now: Date.now,
  selfExecutablePath: () => process.execPath,
  wingetOwnership: probeWingetOwnership,
};

export interface ProbingService {
  probeRuntimes(
    params: RuntimeProbeRuntimesParams,
    signal?: AbortSignal
  ): Promise<RuntimeProbeRuntimesResult>;
  probeVersionManagers(
    params: RuntimeProbeVersionManagersParams,
    signal?: AbortSignal
  ): Promise<RuntimeProbeVersionManagersResult>;
  probeAgentClis(
    params: RuntimeProbeAgentClisParams,
    signal?: AbortSignal
  ): Promise<RuntimeProbeAgentClisResult>;
}

function pathApi(platform: string): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

/** Definitions the caller asked for, in declaration order; unknown ids are refused. */
function selectById<T, Id extends string>(
  definitions: readonly T[],
  idOf: (definition: T) => Id,
  requested: readonly Id[] | undefined,
  label: string
): readonly T[] {
  if (!requested) return definitions;
  const known = new Set(definitions.map(idOf));
  const unknown = requested.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new RuntimeToolArgumentError(`Unknown ${label}: ${unknown.join(', ')}.`);
  }
  const wanted = new Set<string>(requested);
  return definitions.filter((definition) => wanted.has(idOf(definition)));
}

async function scanRuntimeDefinition(
  adapters: ProbingHostAdapters,
  definition: RuntimeDefinition,
  env: PathEnv,
  params: RuntimeProbeRuntimesParams,
  signal?: AbortSignal
): Promise<RuntimeScanResult> {
  throwIfAborted(signal);
  const scan = await scanRuntime(
    definition,
    adapters.createScanDeps(env, definition, params.budget, signal)
  );
  // `scanRuntime` turns a rejected version probe into `null`, including an
  // AbortError from the forwarded signal, so a cancelled call would otherwise
  // come back as a normal missing/ok status.
  throwIfAborted(signal);
  return scan;
}

/**
 * Turns a completed scan into the status the hub reads. Split from
 * {@link scanRuntimeDefinition} so `probeRuntimes` can run every definition's
 * scan alongside the one winget ownership probe it needs, instead of paying
 * for winget sequentially after each scan finishes.
 */
function analyzeScannedRuntime(
  definition: RuntimeDefinition,
  scan: RuntimeScanResult,
  env: PathEnv,
  params: RuntimeProbeRuntimesParams,
  probedAtMs: number,
  wingetOwnership?: WingetOwnership
): RuntimeStatus {
  // Only Node needs this: winget's own MSI and the nodejs.org MSI are
  // indistinguishable by path, so `system` there is ambiguous in a way no
  // other runtime's `system` is.
  const installations =
    definition.id === 'node' && wingetOwnership === 'owned'
      ? markWingetOwnedNodeInstallations(scan.installations, env.env.ProgramFiles)
      : scan.installations;
  const minimumVersion = params.minimumVersions?.[definition.id];
  const consumerRequirements = params.consumerMinimumVersions?.[definition.id];
  return analyzeRuntimeScan(
    definition,
    { ...scan, installations },
    {
      probedAtMs,
      installable: params.installable?.[definition.id] ?? false,
      ...(minimumVersion !== undefined && { minimumVersion }),
      ...(consumerRequirements !== undefined && { consumerRequirements }),
    }
  );
}

async function probeRuntimeDefinition(
  adapters: ProbingHostAdapters,
  definition: RuntimeDefinition,
  env: PathEnv,
  params: RuntimeProbeRuntimesParams,
  signal?: AbortSignal
): Promise<RuntimeStatus> {
  const scan = await scanRuntimeDefinition(adapters, definition, env, params, signal);
  return analyzeScannedRuntime(definition, scan, env, params, adapters.now());
}

/** Every manager `probeVersionManagers` can answer; both are asked unless the caller narrows it. */
const SUPPORTED_VERSION_MANAGER_IDS: readonly VersionManagerId[] = ['nvm', 'fnm'];

/**
 * `fnm --version` (and any future manager scanned the same way) prints
 * vendor-prefixed text (`fnm 1.38.1`); `RuntimeInstallation.version` stores
 * that raw stdout, so this reparses it through the definition's own
 * `parseVersion` to get the plain `major.minor.patch` a version-manager
 * status publishes.
 */
function formattedManagerVersion(
  status: RuntimeStatus | null,
  definition: RuntimeDefinition | undefined
): string | undefined {
  const raw = status?.effective?.version;
  if (!raw || !definition) return undefined;
  const parsed = definition.parseVersion(raw);
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : undefined;
}

/** Whether this `probeRuntimes` call should ask winget about Node at all. */
function needsWingetOwnership(
  adapters: ProbingHostAdapters,
  definitions: readonly RuntimeDefinition[],
  env: PathEnv
): boolean {
  return (
    env.platform === 'win32' &&
    adapters.wingetOwnership !== undefined &&
    definitions.some((definition) => definition.id === 'node')
  );
}

function mapRuntimeFindings(status: RuntimeStatus, targetId: LibraryTargetId): RuntimeFinding[] {
  return status.findings.map((finding) =>
    finding.code === 'not-found' ? { code: 'cli-not-installed', params: { targetId } } : finding
  );
}

function appendLocationFindings(
  findings: RuntimeFinding[],
  locations: readonly LibraryLocationStatus[]
): void {
  // Distinct location ids can resolve to one file (Claude reads settings.json as
  // both `claude-settings` and `claude-hooks`), so report each path only once.
  const reportedPaths = new Set<string>();
  for (const location of locations) {
    // Propagation never writes to a read-only location, so its mode cannot make
    // an apply fail — warning about it would be a permanent, unactionable nag.
    if (location.access !== 'read-write') continue;
    if (!location.exists || location.path === null || location.writable) continue;
    if (reportedPaths.has(location.path)) continue;
    reportedPaths.add(location.path);
    findings.push({
      code: 'location-unwritable',
      params: { locationId: location.id, path: location.path },
    });
  }
}

function healthForAgent(
  baseHealth: RuntimeHealth,
  findings: readonly RuntimeFinding[]
): RuntimeHealth {
  if (findings.some((finding) => finding.code === 'cli-not-installed')) return 'missing';
  if (baseHealth === 'error') return 'error';
  return findings.length > 0 ? 'warn' : 'ok';
}

function authForExternalTarget(
  adapters: ProbingHostAdapters,
  definition: ExternalAgentCliDefinition,
  configHome: string,
  platform: string
) {
  const authPath = pathApi(platform).join(configHome, definition.auth.fileName);
  if (definition.auth.kind === 'file') {
    return probeAuthFile(
      authPath,
      { unknownWhenMissing: definition.auth.unknownWhenMissing },
      adapters.authFs
    );
  }
  return probeConfigKey(authPath, definition.auth.key, adapters.authFs);
}

function describeSelfAgent(
  adapters: ProbingHostAdapters,
  targetId: 'mangostudio',
  env: PathEnv,
  params: RuntimeProbeAgentClisParams
): AgentCliStatus {
  const target = getLibraryTarget(targetId);
  if (!target) throw new Error(`Missing library target definition for "${targetId}".`);

  // The hub pins these for its own machine, where its configured paths and its
  // own executable are the truth. Everywhere else this host answers for itself.
  const configHome = params.self.configHome ?? target.resolveConfigHome(env);
  const executablePath = params.self.executablePath ?? adapters.selfExecutablePath();
  const configHomeExists = directoryExists(configHome, adapters.authFs);
  const locations = adapters.describeLocations(targetId, env);
  const findings: RuntimeFinding[] = [];
  if (!configHomeExists) {
    findings.push({ code: 'config-home-missing', params: { configHome } });
  }
  appendLocationFindings(findings, locations);

  const installation = {
    path: executablePath,
    rawPath: executablePath,
    version: params.self.version,
    origin: 'configured' as const,
    effective: true,
  };

  return {
    id: targetId,
    targetId,
    health: findings.length > 0 ? 'warn' : 'ok',
    installations: [installation],
    effective: installation,
    findings,
    installable: false,
    probedAtMs: adapters.now(),
    configHome,
    configHomeExists,
    // Every route that reaches this service is behind `requireAuth`, so the
    // running process only ever answers on behalf of a signed-in session.
    authenticated: true,
    authSignal: 'session',
    locations,
  };
}

async function describeExternalAgent(
  adapters: ProbingHostAdapters,
  definition: ExternalAgentCliDefinition,
  env: PathEnv,
  params: RuntimeProbeAgentClisParams,
  signal?: AbortSignal
): Promise<AgentCliStatus> {
  throwIfAborted(signal);
  const scan = await scanRuntime(
    definition.runtime,
    adapters.createScanDeps(env, definition.runtime, params.budget, signal)
  );
  throwIfAborted(signal);
  const runtimeStatus = analyzeRuntimeScan(definition.runtime, scan, {
    probedAtMs: adapters.now(),
    installable: params.installable?.[definition.targetId] ?? false,
  });

  const target = getLibraryTarget(definition.targetId);
  if (!target) {
    throw new Error(`Missing library target definition for "${definition.targetId}".`);
  }

  const configHome = target.resolveConfigHome(env);
  const configHomeExists = directoryExists(configHome, adapters.authFs);
  const auth = authForExternalTarget(adapters, definition, configHome, env.platform);
  const locations = adapters.describeLocations(definition.targetId, env);
  const findings = mapRuntimeFindings(runtimeStatus, definition.targetId);
  const cliInstalled = !findings.some((finding) => finding.code === 'cli-not-installed');

  if (cliInstalled && !configHomeExists) {
    findings.push({ code: 'config-home-missing', params: { configHome } });
  }
  if (cliInstalled && configHomeExists && !auth.authenticated && auth.authSignal !== 'unknown') {
    findings.push({ code: 'not-authenticated', params: { targetId: definition.targetId } });
  }
  appendLocationFindings(findings, locations);

  return {
    ...runtimeStatus,
    targetId: definition.targetId,
    health: healthForAgent(runtimeStatus.health, findings),
    findings,
    configHome,
    configHomeExists,
    authenticated: auth.authenticated,
    authSignal: auth.authSignal,
    locations,
  };
}

export function createProbingService(overrides: Partial<ProbingHostAdapters> = {}): ProbingService {
  const adapters: ProbingHostAdapters = { ...DEFAULT_ADAPTERS, ...overrides };

  return {
    async probeRuntimes(params, signal) {
      throwIfAborted(signal);
      const env = adapters.createPathEnv(params.pathEnv);
      const definitions = selectById(
        adapters.runtimeDefinitions,
        (definition) => definition.id,
        params.ids,
        'runtime id'
      );

      // The winget probe runs alongside every scan rather than after it: on a
      // Windows host that already pays `probeTimeoutMs` per candidate, adding
      // winget's own 15s sequentially would nearly triple a plain Node probe.
      const wingetOwnershipPromise = needsWingetOwnership(adapters, definitions, env)
        ? adapters.wingetOwnership?.(NODE_LTS_WINGET_PACKAGE_ID, signal)
        : undefined;
      const [scans, wingetOwnership] = await Promise.all([
        Promise.all(
          definitions.map((definition) =>
            scanRuntimeDefinition(adapters, definition, env, params, signal)
          )
        ),
        wingetOwnershipPromise,
      ]);
      // The default winget adapter maps an abort to `unknown` rather than
      // rejecting, so a cancellation that lands while every scan has already
      // settled would otherwise resolve here unnoticed.
      throwIfAborted(signal);

      const probedAtMs = adapters.now();
      const statuses = definitions.map((definition, index) =>
        analyzeScannedRuntime(
          definition,
          scans[index] as RuntimeScanResult,
          env,
          params,
          probedAtMs,
          wingetOwnership
        )
      );
      return { statuses };
    },

    async probeVersionManagers(params, signal) {
      throwIfAborted(signal);
      // nvm and fnm are both detected today, and both are asked for unless the
      // caller narrows it; any other id is answered with an empty list rather
      // than an error, the way the hub's registry already does for an id it
      // holds no definition for.
      const wanted = (params.ids ?? SUPPORTED_VERSION_MANAGER_IDS).filter((id) =>
        SUPPORTED_VERSION_MANAGER_IDS.includes(id)
      );
      if (wanted.length === 0) return { statuses: [] };

      const env = adapters.createPathEnv(params.pathEnv);
      const runtimeParams: RuntimeProbeRuntimesParams = {
        ...(params.budget && { budget: params.budget }),
      };
      const nodeDefinition = adapters.runtimeDefinitions.find(
        (definition) => definition.id === 'node'
      );
      // Which Node each manager considers current is read from the one scan
      // the toolchain tab shows, so no manager can disagree with it about that.
      const nodeStatus = nodeDefinition
        ? await probeRuntimeDefinition(adapters, nodeDefinition, env, runtimeParams, signal)
        : null;
      throwIfAborted(signal);
      const currentNodePathFor = (managerId: VersionManagerId): string | undefined =>
        nodeStatus?.effective?.managedBy === managerId ? nodeStatus.effective.path : undefined;

      const latestByMajor = params.latestByMajor
        ? new Map(
            Object.entries(params.latestByMajor).map(([major, version]) => [Number(major), version])
          )
        : undefined;
      const scheduleOptions = {
        now: new Date(adapters.now()),
        schedule: NODE_RELEASE_SCHEDULE,
        ...(latestByMajor !== undefined && { latestByMajor, liveDataAvailable: true }),
      };

      const statuses = await Promise.all(
        wanted.map(async (id): Promise<VersionManagerStatus> => {
          const currentNodePath = currentNodePathFor(id);
          if (id === 'nvm') {
            return detectNvm(adapters.createNvmDeps(env), {
              ...scheduleOptions,
              ...(currentNodePath !== undefined && { currentNodePath }),
            });
          }

          const fnmDefinition = adapters.runtimeDefinitions.find(
            (definition) => definition.id === 'fnm'
          );
          // fnm's own version comes from the same scan `probeRuntimes` already
          // runs for it, rather than spawning `fnm --version` a second time.
          const fnmRuntimeStatus = fnmDefinition
            ? await probeRuntimeDefinition(adapters, fnmDefinition, env, runtimeParams, signal)
            : null;
          throwIfAborted(signal);
          const managerVersion = formattedManagerVersion(fnmRuntimeStatus, fnmDefinition);
          return detectFnm(adapters.createFnmDeps(env), {
            ...scheduleOptions,
            ...(currentNodePath !== undefined && { currentNodePath }),
            ...(managerVersion !== undefined && { managerVersion }),
          });
        })
      );
      throwIfAborted(signal);
      return { statuses };
    },

    async probeAgentClis(params, signal) {
      throwIfAborted(signal);
      // One env snapshot per listing: every target reads the same host state,
      // and rebuilding it per definition re-copies the process environment.
      const env = adapters.createPathEnv(params.pathEnv);
      const definitions = selectById(
        adapters.agentDefinitions,
        (definition: AgentCliDefinition) => definition.targetId,
        params.targetIds,
        'agent target id'
      );
      const statuses = await Promise.all(
        definitions.map((definition) => {
          throwIfAborted(signal);
          return definition.kind === 'self'
            ? Promise.resolve(describeSelfAgent(adapters, definition.targetId, env, params))
            : describeExternalAgent(adapters, definition, env, params, signal);
        })
      );
      return { statuses };
    },
  };
}

export const probingService = createProbingService();
