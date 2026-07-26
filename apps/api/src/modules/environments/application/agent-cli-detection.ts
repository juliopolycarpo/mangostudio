import { dirname, posix, win32 } from 'node:path';
import type {
  AgentCliStatus,
  RuntimeFinding,
  RuntimeHealth,
  RuntimeStatus,
} from '@mangostudio/shared/environments';
import type { LibraryLocationStatus, LibraryTargetId } from '@mangostudio/shared/library';
import { getConfig, getVersion } from '../../../lib/config';
import type { PathEnv } from '../../../lib/path-env';
import { getLibraryTarget } from '../../library/domain/registry';
import {
  createLibraryPathEnv,
  describeTargetLocations,
} from '../../library/infrastructure/location-probe';
import {
  AGENT_CLI_DEFINITIONS,
  type AgentCliDefinition,
  type ExternalAgentCliDefinition,
} from '../domain/agent-cli-definitions';
import {
  type AuthSignalFs,
  directoryExists,
  NODE_AUTH_SIGNAL_FS,
  probeAuthFile,
  probeConfigKey,
} from '../domain/auth-signal';
import type { BinaryScanDeps, RuntimeDefinition } from '../domain/binary-scan';
import { createRuntimeDetectionService, type RuntimeDetectionService } from './runtime-detection';

interface AgentCliDetectionOptions {
  readonly force?: boolean;
}

export interface AgentCliDetectionService {
  listAgentCliStatuses(options?: AgentCliDetectionOptions): Promise<AgentCliStatus[]>;
  getAgentCliStatus(
    targetId: LibraryTargetId,
    options?: AgentCliDetectionOptions
  ): Promise<AgentCliStatus | null>;
  resetAgentCliCache(targetId?: LibraryTargetId): void;
}

export interface AgentCliDetectionServiceOptions {
  readonly definitions?: readonly AgentCliDefinition[];
  readonly runtimeService?: RuntimeDetectionService;
  readonly createScanDeps?: (definition: RuntimeDefinition) => BinaryScanDeps;
  readonly createPathEnv?: () => PathEnv;
  readonly fs?: AuthSignalFs;
  readonly describeLocations?: (targetId: LibraryTargetId, env: PathEnv) => LibraryLocationStatus[];
  readonly now?: () => number;
  readonly isInstallable?: (targetId: LibraryTargetId, platform: string) => boolean;
  readonly getSelfVersion?: () => string;
  readonly getSelfExecutablePath?: () => string;
  readonly getSelfConfigHome?: () => string;
}

function pathApi(platform: string): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

function mapRuntimeFindings(status: RuntimeStatus, targetId: LibraryTargetId): RuntimeFinding[] {
  return status.findings.map((finding) => {
    if (finding.code === 'not-found') {
      return { code: 'cli-not-installed', params: { targetId } };
    }
    return finding;
  });
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
  definition: ExternalAgentCliDefinition,
  configHome: string,
  platform: string,
  fs: AuthSignalFs
) {
  const authPath = pathApi(platform).join(configHome, definition.auth.fileName);
  if (definition.auth.kind === 'file') {
    return probeAuthFile(authPath, { unknownWhenMissing: definition.auth.unknownWhenMissing }, fs);
  }
  return probeConfigKey(authPath, definition.auth.key, fs);
}

export function createAgentCliDetectionService(
  options: AgentCliDetectionServiceOptions = {}
): AgentCliDetectionService {
  const definitions = options.definitions ?? AGENT_CLI_DEFINITIONS;
  const definitionsById = new Map(
    definitions.map((definition) => [definition.targetId, definition] as const)
  );
  const externalDefinitions = definitions.filter(
    (definition): definition is ExternalAgentCliDefinition => definition.kind === 'cli'
  );
  const now = options.now ?? Date.now;
  const runtimeService =
    options.runtimeService ??
    createRuntimeDetectionService({
      definitions: externalDefinitions.map((definition) => definition.runtime),
      ...(options.createScanDeps && { createDeps: options.createScanDeps }),
      now,
      isInstallable: (id, platform) =>
        options.isInstallable?.(id as LibraryTargetId, platform) ?? false,
    });
  const createPathEnv = options.createPathEnv ?? createLibraryPathEnv;
  const fs = options.fs ?? NODE_AUTH_SIGNAL_FS;
  const describeLocations = options.describeLocations ?? describeTargetLocations;
  const getSelfVersion = options.getSelfVersion ?? getVersion;
  const getSelfExecutablePath = options.getSelfExecutablePath ?? (() => process.execPath);
  const getSelfConfigHome =
    options.getSelfConfigHome ?? (() => dirname(getConfig().configFilePath));

  const describeSelf = (
    definition: Extract<AgentCliDefinition, { kind: 'self' }>,
    env: PathEnv
  ): AgentCliStatus => {
    const configHome = getSelfConfigHome();
    const configHomeExists = directoryExists(configHome, fs);
    const locations = describeLocations(definition.targetId, env);
    const findings: RuntimeFinding[] = [];
    if (!configHomeExists) {
      findings.push({ code: 'config-home-missing', params: { configHome } });
    }
    appendLocationFindings(findings, locations);

    const executablePath = getSelfExecutablePath();
    const installation = {
      path: executablePath,
      rawPath: executablePath,
      version: getSelfVersion(),
      origin: 'configured' as const,
      effective: true,
    };

    return {
      id: definition.targetId,
      targetId: definition.targetId,
      health: findings.length > 0 ? 'warn' : 'ok',
      installations: [installation],
      effective: installation,
      findings,
      installable: false,
      probedAtMs: now(),
      configHome,
      configHomeExists,
      // Every route that reaches this service is behind `requireAuth`, so the
      // running process only ever answers on behalf of a signed-in session.
      authenticated: true,
      authSignal: 'session',
      locations,
    };
  };

  const describeExternal = async (
    definition: ExternalAgentCliDefinition,
    env: PathEnv,
    detectOptions?: AgentCliDetectionOptions
  ): Promise<AgentCliStatus> => {
    const runtimeStatus = await runtimeService.getRuntimeStatus(definition.runtime.id, {
      force: detectOptions?.force,
    });
    if (!runtimeStatus) {
      throw new Error(`Missing runtime definition for agent target "${definition.targetId}".`);
    }

    const target = getLibraryTarget(definition.targetId);
    if (!target) {
      throw new Error(`Missing library target definition for "${definition.targetId}".`);
    }

    const configHome = target.resolveConfigHome(env);
    const configHomeExists = directoryExists(configHome, fs);
    const auth = authForExternalTarget(definition, configHome, env.platform, fs);
    const locations = describeLocations(definition.targetId, env);
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
  };

  const describeTarget = (
    definition: AgentCliDefinition,
    env: PathEnv,
    detectOptions?: AgentCliDetectionOptions
  ): Promise<AgentCliStatus> =>
    definition.kind === 'self'
      ? Promise.resolve(describeSelf(definition, env))
      : describeExternal(definition, env, detectOptions);

  const getAgentCliStatus = (
    targetId: LibraryTargetId,
    detectOptions?: AgentCliDetectionOptions
  ): Promise<AgentCliStatus | null> => {
    const definition = definitionsById.get(targetId);
    if (!definition) return Promise.resolve(null);
    return describeTarget(definition, createPathEnv(), detectOptions);
  };

  return {
    getAgentCliStatus,

    listAgentCliStatuses(detectOptions?: AgentCliDetectionOptions) {
      // One env snapshot per listing: every target reads the same process state,
      // and rebuilding it per definition re-copies process.env and re-reads config.
      const env = createPathEnv();
      return Promise.all(
        definitions.map((definition) => describeTarget(definition, env, detectOptions))
      );
    },

    resetAgentCliCache(targetId?: LibraryTargetId) {
      if (!targetId) {
        runtimeService.resetRuntimeCache();
        return;
      }
      if (targetId === 'mangostudio') return;
      runtimeService.resetRuntimeCache(targetId);
    },
  };
}

export const agentCliDetectionService = createAgentCliDetectionService();
