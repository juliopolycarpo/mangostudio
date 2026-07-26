/**
 * Provider-agnostic Node.js runtime detection for SDK sidecars.
 *
 * The generic environments scanner discovers every working Node candidate.
 * This adapter preserves the provider gate's configured-path authority,
 * minimum-version policy, reason codes, and cached public API.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import {
  type BinaryScanDeps,
  binaryCandidateNames,
  scanRuntime,
} from '../../../../modules/environments/domain/binary-scan';
import {
  NODE_RUNTIME_DEFINITION,
  parseNodeVersion,
  wellKnownNodeDirectories as runtimeWellKnownNodeDirectories,
} from '../../../../modules/environments/domain/runtime-definitions';

const execFileAsync = promisify(execFile);
const DEFAULT_CACHE_TTL_MS = 30_000;
const NODE_SIDECAR_RUNTIME_DEFINITION = {
  ...NODE_RUNTIME_DEFINITION,
  includeBareBinaryNames: true,
} as const;

interface NodeRuntimeReasonParams {
  foundVersion?: string;
  nodePath?: string;
  packageName?: string;
  sidecarPath?: string;
}

export interface NodeRuntimeStatus<ReasonCode extends string = string> {
  available: boolean;
  reasonCode?: ReasonCode;
  reasonParams?: NodeRuntimeReasonParams;
  nodePath?: string;
  version?: string;
}

interface MinimumNodeVersion {
  major: number;
  minor: number;
}

interface NodeRuntimeReasonCodes<ReasonCode extends string> {
  nodeNotFound: ReasonCode;
  nodeInvalid: ReasonCode;
  versionInsufficient: ReasonCode;
}

export interface NodeRuntimeDetectorOptions<ReasonCode extends string> {
  minimumVersion: MinimumNodeVersion;
  reasonCodes: NodeRuntimeReasonCodes<ReasonCode>;
  getConfiguredNodePath?: () => string;
  cacheTtlMs?: number;
}

/** Injectable environment for probeNodeRuntime, faked in unit tests. */
export interface NodeRuntimeProbeDeps {
  platform: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  /** Configured override supplied by the provider; empty means auto-detect. */
  configuredNodePath: string;
  pathExists: (path: string) => boolean;
  /** Runs `<binary> --version`, returning trimmed stdout or null on any failure. */
  probeVersion: (binary: string) => Promise<string | null>;
}

interface NodeRuntimeCache<ReasonCode extends string> {
  checkedAt: number;
  key: string;
  status: NodeRuntimeStatus<ReasonCode>;
}

interface InflightNodeRuntime<ReasonCode extends string> {
  key: string;
  promise: Promise<NodeRuntimeStatus<ReasonCode>>;
}

export interface NodeRuntimeDetector<ReasonCode extends string> {
  detectNodeRuntime(options?: { force?: boolean }): Promise<NodeRuntimeStatus<ReasonCode>>;
  probeNodeRuntime(
    overrides?: Partial<NodeRuntimeProbeDeps>
  ): Promise<NodeRuntimeStatus<ReasonCode>>;
  resetNodeRuntimeCache(): void;
}

function meetsMinimumVersion(
  version: { major: number; minor: number },
  minimumVersion: MinimumNodeVersion
): boolean {
  if (version.major > minimumVersion.major) return true;
  if (version.major < minimumVersion.major) return false;
  return version.minor >= minimumVersion.minor;
}

/** Runs `<binary> --version` off the event loop, returning trimmed stdout or null. */
async function probeNodeVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 2_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function defaultProbeDeps(options: NodeRuntimeDetectorOptions<string>): NodeRuntimeProbeDeps {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
    configuredNodePath: options.getConfiguredNodePath?.().trim() ?? '',
    pathExists: existsSync,
    probeVersion: probeNodeVersion,
  };
}

function toBinaryScanDeps(
  deps: NodeRuntimeProbeDeps,
  minimumVersion: MinimumNodeVersion
): BinaryScanDeps {
  const configuredPath = deps.configuredNodePath.trim();
  return {
    platform: deps.platform,
    env: deps.env,
    homeDir: deps.homeDir,
    pathExists: deps.pathExists,
    probeVersion: (binary) => deps.probeVersion(binary),
    realpath,
    // This is a gate, not an inventory: stop at the first Node that clears the
    // bar so the sidecar check keeps costing one probe on a healthy machine.
    stopWhen: (version) => {
      const parsed = parseNodeVersion(version);
      return parsed !== null && meetsMinimumVersion(parsed, minimumVersion);
    },
    ...(configuredPath && { configuredPath, configuredOnly: true }),
  };
}

/**
 * Binary names to try inside each candidate directory. On Windows the PATHEXT
 * order is honored so `node.cmd` shims are found, not just `node.exe`.
 */
export function nodeBinaryCandidateNames(
  deps: Pick<NodeRuntimeProbeDeps, 'platform' | 'env'>
): string[] {
  return binaryCandidateNames(NODE_RUNTIME_DEFINITION, {
    platform: deps.platform,
    env: deps.env,
  });
}

/** Bounded, ordered Node install directories used after PATH entries. */
export function wellKnownNodeDirectories(
  deps: Pick<NodeRuntimeProbeDeps, 'platform' | 'env' | 'homeDir'>
): string[] {
  return runtimeWellKnownNodeDirectories(deps);
}

/**
 * Resolves Node availability through the generic scanner. A configured path is
 * authoritative: it never falls back to auto-detection.
 */
async function probeRuntime<ReasonCode extends string>(
  options: NodeRuntimeDetectorOptions<ReasonCode>,
  overrides: Partial<NodeRuntimeProbeDeps> = {}
): Promise<NodeRuntimeStatus<ReasonCode>> {
  const deps: NodeRuntimeProbeDeps = { ...defaultProbeDeps(options), ...overrides };
  const result = await scanRuntime(
    NODE_SIDECAR_RUNTIME_DEFINITION,
    toBinaryScanDeps(deps, options.minimumVersion)
  );
  const configuredPath = deps.configuredNodePath.trim();

  if (configuredPath && result.installations.length === 0) {
    return {
      available: false,
      nodePath: configuredPath,
      reasonCode: options.reasonCodes.nodeInvalid,
      reasonParams: { nodePath: configuredPath },
    };
  }

  const supported = result.installations.find((installation) => {
    const version = parseNodeVersion(installation.version);
    return version && meetsMinimumVersion(version, options.minimumVersion);
  });
  if (supported) {
    return {
      available: true,
      nodePath: supported.rawPath,
      version: supported.version,
    };
  }

  const firstInstallation = result.installations[0];
  if (firstInstallation) {
    return {
      available: false,
      nodePath: firstInstallation.rawPath,
      version: firstInstallation.version,
      reasonCode: options.reasonCodes.versionInsufficient,
      reasonParams: { foundVersion: firstInstallation.version },
    };
  }

  return { available: false, reasonCode: options.reasonCodes.nodeNotFound };
}

function detectorEnvironmentKey(configuredNodePath: string): string {
  return createHash('sha256')
    .update(process.platform)
    .update('\0')
    .update(configuredNodePath)
    .update('\0')
    .update(process.env.PATH ?? '')
    .update('\0')
    .update(process.env.PATHEXT ?? '')
    .digest('hex');
}

/**
 * Creates a cached runtime detector for one provider-side sidecar. Each
 * provider gets its own cache so minimum versions and configured paths cannot
 * bleed into each other. PATH changes also invalidate cached detection.
 */
export function createNodeRuntimeDetector<ReasonCode extends string>(
  options: NodeRuntimeDetectorOptions<ReasonCode>
): NodeRuntimeDetector<ReasonCode> {
  let cached: NodeRuntimeCache<ReasonCode> | null = null;
  let inflight: InflightNodeRuntime<ReasonCode> | null = null;
  /** Only the most recently started probe may publish a cache entry. */
  let probeGeneration = 0;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  return {
    probeNodeRuntime(overrides?: Partial<NodeRuntimeProbeDeps>) {
      return probeRuntime(options, overrides);
    },

    detectNodeRuntime(detectOptions?: { force?: boolean }) {
      const now = Date.now();
      const configuredNodePath = options.getConfiguredNodePath?.().trim() ?? '';
      const key = detectorEnvironmentKey(configuredNodePath);
      if (
        !detectOptions?.force &&
        cached &&
        cached.key === key &&
        now - cached.checkedAt < cacheTtlMs
      ) {
        return Promise.resolve(cached.status);
      }

      if (!detectOptions?.force && inflight?.key === key) return inflight.promise;

      probeGeneration += 1;
      const generation = probeGeneration;
      const promise = probeRuntime(options)
        .then((status) => {
          if (generation === probeGeneration) cached = { checkedAt: Date.now(), key, status };
          return status;
        })
        .finally(() => {
          if (inflight?.promise === promise) inflight = null;
        });

      inflight = { key, promise };
      return promise;
    },

    resetNodeRuntimeCache() {
      cached = null;
      inflight = null;
      // Retires in-flight probes so a pre-reset scan cannot repopulate the cache.
      probeGeneration += 1;
    },
  };
}
