import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  cursorNativePackageForNodeRuntime,
  isCursorSdkChunkFileName,
} from '@mangostudio/shared/catalog';
import type { ProviderRuntimeUnavailableReasonParams } from '@mangostudio/shared/provider-settings';
import { getCursorSidecarScriptPath } from '../../../lib/runtime-paths';
import { detectNodeRuntime, type NodeRuntimeStatus, resetNodeRuntimeCache } from './node-runtime';

export interface CursorRuntimeStatus extends NodeRuntimeStatus {
  sidecarScriptPath?: string;
}

interface CursorRuntimeAvailabilityOptions {
  arch?: string;
  devSdkPackagePath?: string;
  pathExists?: (path: string) => boolean;
  readDir?: (path: string) => readonly string[];
  sidecarScriptPath?: string;
  sidecarExists?: (path: string) => boolean;
  platform?: string;
}

interface CursorRuntimeCache {
  checkedAt: number;
  status: CursorRuntimeStatus;
}

const CACHE_TTL_MS = 30_000;
const CURSOR_SCOPE_DIR = '@cursor';
const CURSOR_SDK_DIR = 'sdk';
const SDK_PACKAGE_JSON = join(CURSOR_SCOPE_DIR, CURSOR_SDK_DIR, 'package.json');
const SDK_DIST_FLAVORS = ['cjs', 'esm'] as const;

let cached: CursorRuntimeCache | null = null;
let inflight: Promise<CursorRuntimeStatus> | null = null;

function defaultDevSdkPackagePaths(): string[] {
  return [
    join(import.meta.dir, '..', '..', '..', '..', 'node_modules', SDK_PACKAGE_JSON),
    join(process.cwd(), 'apps', 'api', 'node_modules', SDK_PACKAGE_JSON),
  ];
}

function packagePathSegments(packageName: string): string[] {
  return packageName.split('/');
}

function hasNumberedChunk(
  sdkPackageDir: string,
  flavor: (typeof SDK_DIST_FLAVORS)[number],
  readDir: (path: string) => readonly string[]
): boolean {
  try {
    return readDir(join(sdkPackageDir, 'dist', flavor)).some(isCursorSdkChunkFileName);
  } catch {
    return false;
  }
}

function sdkPackageComplete(
  sdkPackageDir: string,
  readDir: (path: string) => readonly string[]
): boolean {
  return SDK_DIST_FLAVORS.every((flavor) => hasNumberedChunk(sdkPackageDir, flavor, readDir));
}

export function evaluateCursorRuntimeAvailability(
  nodeRuntime: NodeRuntimeStatus,
  options: CursorRuntimeAvailabilityOptions = {}
): CursorRuntimeStatus {
  if (!nodeRuntime.available) {
    return {
      ...nodeRuntime,
      available: false,
      reasonCode: nodeRuntime.reasonCode ?? 'cursor.node_not_found',
    };
  }

  const sidecarScriptPath = options.sidecarScriptPath ?? getCursorSidecarScriptPath();
  const pathExists = options.pathExists ?? existsSync;
  const readDir = options.readDir ?? readdirSync;
  const sidecarExists = options.sidecarExists ?? pathExists;
  if (!sidecarExists(sidecarScriptPath)) {
    const reasonParams: ProviderRuntimeUnavailableReasonParams = { sidecarPath: sidecarScriptPath };
    return {
      ...nodeRuntime,
      available: false,
      sidecarScriptPath,
      reasonCode: 'cursor.sidecar_missing',
      reasonParams,
    };
  }

  const sidecarDir = dirname(sidecarScriptPath);
  const sidecarNodeModulesDir = join(sidecarDir, 'node_modules');
  if (!pathExists(sidecarNodeModulesDir)) {
    const devSdkPackagePaths = options.devSdkPackagePath
      ? [options.devSdkPackagePath]
      : defaultDevSdkPackagePaths();
    if (!devSdkPackagePaths.some(pathExists)) {
      return {
        ...nodeRuntime,
        available: false,
        sidecarScriptPath,
        reasonCode: 'cursor.sdk_missing',
        reasonParams: { sidecarPath: sidecarScriptPath },
      };
    }

    return {
      ...nodeRuntime,
      available: true,
      sidecarScriptPath,
    };
  }

  const sdkPackageDir = join(sidecarNodeModulesDir, CURSOR_SCOPE_DIR, CURSOR_SDK_DIR);
  if (!pathExists(join(sdkPackageDir, 'package.json'))) {
    return {
      ...nodeRuntime,
      available: false,
      sidecarScriptPath,
      reasonCode: 'cursor.sdk_missing',
      reasonParams: { sidecarPath: sidecarScriptPath },
    };
  }

  if (!sdkPackageComplete(sdkPackageDir, readDir)) {
    return {
      ...nodeRuntime,
      available: false,
      sidecarScriptPath,
      reasonCode: 'cursor.sdk_incomplete',
      reasonParams: { sidecarPath: sidecarScriptPath },
    };
  }

  const nativePackage = cursorNativePackageForNodeRuntime(
    options.platform ?? process.platform,
    options.arch ?? process.arch
  );
  if (!nativePackage) {
    return {
      ...nodeRuntime,
      available: false,
      sidecarScriptPath,
      reasonCode: 'cursor.native_runtime_missing',
      reasonParams: { sidecarPath: sidecarScriptPath },
    };
  }

  if (
    !pathExists(join(sidecarNodeModulesDir, ...packagePathSegments(nativePackage), 'package.json'))
  ) {
    return {
      ...nodeRuntime,
      available: false,
      sidecarScriptPath,
      reasonCode: 'cursor.native_runtime_missing',
      reasonParams: { packageName: nativePackage, sidecarPath: sidecarScriptPath },
    };
  }

  return {
    ...nodeRuntime,
    available: true,
    sidecarScriptPath,
  };
}

export function detectCursorRuntimeAvailability(options?: {
  force?: boolean;
}): Promise<CursorRuntimeStatus> {
  const now = Date.now();
  if (!options?.force && cached && now - cached.checkedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached.status);
  }

  if (!options?.force && inflight) return inflight;

  const probe = detectNodeRuntime({ force: options?.force })
    .then((nodeRuntime) => evaluateCursorRuntimeAvailability(nodeRuntime))
    .then((status) => {
      cached = { checkedAt: Date.now(), status };
      return status;
    })
    .finally(() => {
      if (inflight === probe) inflight = null;
    });

  inflight = probe;
  return probe;
}

/**
 * Clears the cached availability probe, including the underlying Node runtime
 * cache it is derived from, so the next detect re-evaluates from scratch.
 */
export function resetCursorRuntimeAvailabilityCache(): void {
  cached = null;
  inflight = null;
  resetNodeRuntimeCache();
}
