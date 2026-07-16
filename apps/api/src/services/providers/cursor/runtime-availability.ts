import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  cursorNativePackageForNodeRuntime,
  formatUnsupportedCursorNativePlatforms,
  isCursorSdkChunkFileName,
} from '@mangostudio/shared/catalog';
import {
  CURSOR_MIN_NODE_VERSION,
  type ProviderRuntimeUnavailableReasonParams,
} from '@mangostudio/shared/provider-settings';
import { getCursorSidecarScriptPath } from '../../../lib/runtime-paths';
import { detectNodeRuntime, type NodeRuntimeStatus } from './node-runtime';
import { formatCursorRuntimeUnavailableReason } from './runtime-reason';

export interface CursorRuntimeStatus extends NodeRuntimeStatus {
  sidecarScriptPath?: string;
}

export interface CursorRuntimeAvailabilityOptions {
  arch?: string;
  devSdkPackagePath?: string;
  pathExists?: (path: string) => boolean;
  readDir?: (path: string) => readonly string[];
  sidecarScriptPath?: string;
  sidecarExists?: (path: string) => boolean;
  platform?: string;
}

type CursorRuntimeChainLink = 'node' | 'sidecar' | 'sdk' | 'native';

export interface CursorRuntimeChainStep {
  link: CursorRuntimeChainLink;
  ok: boolean;
  detail: string;
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

function resolveCursorRuntimeProbeContext(options: CursorRuntimeAvailabilityOptions = {}) {
  const sidecarScriptPath = options.sidecarScriptPath ?? getCursorSidecarScriptPath();
  const pathExists = options.pathExists ?? existsSync;
  const readDir = options.readDir ?? readdirSync;
  const sidecarExists = options.sidecarExists ?? pathExists;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const sidecarDir = dirname(sidecarScriptPath);
  const sidecarNodeModulesDir = join(sidecarDir, 'node_modules');
  const sdkPackageDir = join(sidecarNodeModulesDir, CURSOR_SCOPE_DIR, CURSOR_SDK_DIR);
  const devSdkPackagePaths = options.devSdkPackagePath
    ? [options.devSdkPackagePath]
    : defaultDevSdkPackagePaths();

  return {
    arch,
    devSdkPackagePaths,
    pathExists,
    platform,
    readDir,
    sdkPackageDir,
    sidecarDir,
    sidecarExists,
    sidecarNodeModulesDir,
    sidecarScriptPath,
  };
}

/**
 * Reports each link in the Cursor runtime chain independently so `doctor` can
 * show which step failed without short-circuiting like runtime gating does.
 */
export function describeCursorRuntimeChain(
  nodeRuntime: NodeRuntimeStatus,
  options: CursorRuntimeAvailabilityOptions = {}
): CursorRuntimeChainStep[] {
  const ctx = resolveCursorRuntimeProbeContext(options);
  const steps: CursorRuntimeChainStep[] = [];

  if (nodeRuntime.available) {
    const path = nodeRuntime.nodePath ?? 'node';
    const version = nodeRuntime.version ?? 'unknown';
    steps.push({
      link: 'node',
      ok: true,
      detail: `${path} (${version}, meets >= ${CURSOR_MIN_NODE_VERSION})`,
    });
  } else {
    const reasonCode = nodeRuntime.reasonCode ?? 'cursor.node_not_found';
    steps.push({
      link: 'node',
      ok: false,
      detail: formatCursorRuntimeUnavailableReason(reasonCode, nodeRuntime.reasonParams),
    });
  }

  if (!ctx.sidecarExists(ctx.sidecarScriptPath)) {
    steps.push({
      link: 'sidecar',
      ok: false,
      detail: formatCursorRuntimeUnavailableReason('cursor.sidecar_missing', {
        sidecarPath: ctx.sidecarScriptPath,
      }),
    });
  } else {
    steps.push({
      link: 'sidecar',
      ok: true,
      detail: `${ctx.sidecarScriptPath} (present)`,
    });
  }

  let usingWorkspaceSdk = false;
  if (!ctx.pathExists(ctx.sidecarNodeModulesDir)) {
    const devSdkPath = ctx.devSdkPackagePaths.find(ctx.pathExists);
    if (devSdkPath) {
      usingWorkspaceSdk = true;
      steps.push({
        link: 'sdk',
        ok: true,
        detail: `Cursor SDK package present in workspace (${devSdkPath})`,
      });
    } else {
      steps.push({
        link: 'sdk',
        ok: false,
        detail: formatCursorRuntimeUnavailableReason('cursor.sdk_missing', {
          sidecarPath: ctx.sidecarScriptPath,
        }),
      });
    }
  } else if (!ctx.pathExists(join(ctx.sdkPackageDir, 'package.json'))) {
    steps.push({
      link: 'sdk',
      ok: false,
      detail: formatCursorRuntimeUnavailableReason('cursor.sdk_missing', {
        sidecarPath: ctx.sidecarScriptPath,
      }),
    });
  } else if (!sdkPackageComplete(ctx.sdkPackageDir, ctx.readDir)) {
    steps.push({
      link: 'sdk',
      ok: false,
      detail: formatCursorRuntimeUnavailableReason('cursor.sdk_incomplete', {
        sidecarPath: ctx.sidecarScriptPath,
      }),
    });
  } else {
    steps.push({
      link: 'sdk',
      ok: true,
      detail: `${join(ctx.sdkPackageDir, 'package.json')} (cjs/esm chunks complete)`,
    });
  }

  const nativePackage = cursorNativePackageForNodeRuntime(ctx.platform, ctx.arch);
  if (usingWorkspaceSdk) {
    // The workspace SDK carries its own native runtime, so gating skips the
    // sidecar-tree native probe here; mirror that instead of reporting a
    // false failure against the (absent) sidecar node_modules.
    steps.push({
      link: 'native',
      ok: true,
      detail: 'resolved with workspace SDK (dev)',
    });
  } else if (!nativePackage) {
    const platformLabel = `${ctx.platform}-${ctx.arch}`;
    steps.push({
      link: 'native',
      ok: false,
      detail: `platform unsupported: ${platformLabel} (unsupported targets: ${formatUnsupportedCursorNativePlatforms()})`,
    });
  } else if (
    !ctx.pathExists(
      join(ctx.sidecarNodeModulesDir, ...packagePathSegments(nativePackage), 'package.json')
    )
  ) {
    steps.push({
      link: 'native',
      ok: false,
      detail: formatCursorRuntimeUnavailableReason('cursor.native_runtime_missing', {
        packageName: nativePackage,
        sidecarPath: ctx.sidecarScriptPath,
      }),
    });
  } else {
    steps.push({
      link: 'native',
      ok: true,
      detail: `${nativePackage} (present)`,
    });
  }

  return steps;
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
