/**
 * Detects whether Node.js is available for the Cursor SDK sidecar.
 * The Cursor SDK local agent stream requires Node.js >= 22.13 (Bun is unsupported).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type {
  ProviderRuntimeUnavailableReason,
  ProviderRuntimeUnavailableReasonParams,
} from '@mangostudio/shared/provider-settings';

const execFileAsync = promisify(execFile);

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13;
const CACHE_TTL_MS = 30_000;

export interface NodeRuntimeStatus {
  available: boolean;
  reasonCode?: ProviderRuntimeUnavailableReason;
  reasonParams?: ProviderRuntimeUnavailableReasonParams;
  nodePath?: string;
  version?: string;
}

interface NodeRuntimeCache {
  checkedAt: number;
  status: NodeRuntimeStatus;
}

let cached: NodeRuntimeCache | null = null;
let inflight: Promise<NodeRuntimeStatus> | null = null;

const NODE_BINARY_CANDIDATES = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];

function parseNodeVersion(raw: string): { major: number; minor: number; patch: number } | null {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function meetsMinimumVersion(version: { major: number; minor: number }): boolean {
  if (version.major > MIN_NODE_MAJOR) return true;
  if (version.major < MIN_NODE_MAJOR) return false;
  return version.minor >= MIN_NODE_MINOR;
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

async function resolveNodeBinary(): Promise<string | null> {
  const pathEntries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');

  for (const entry of pathEntries) {
    if (!entry.trim()) continue;
    for (const candidate of NODE_BINARY_CANDIDATES) {
      const fullPath =
        entry.endsWith('/') || entry.endsWith('\\')
          ? `${entry}${candidate}`
          : `${entry}/${candidate}`;
      if (existsSync(fullPath)) return fullPath;
    }
  }

  for (const candidate of NODE_BINARY_CANDIDATES) {
    if (await probeNodeVersion(candidate)) return candidate;
  }

  return null;
}

async function probeNodeRuntime(): Promise<NodeRuntimeStatus> {
  const nodePath = await resolveNodeBinary();
  if (!nodePath) {
    return {
      available: false,
      reasonCode: 'cursor.node_not_found',
    };
  }

  const versionText = await probeNodeVersion(nodePath);
  if (!versionText) {
    return {
      available: false,
      reasonCode: 'cursor.node_not_found',
    };
  }

  const parsed = parseNodeVersion(versionText);
  if (!parsed || !meetsMinimumVersion(parsed)) {
    return {
      available: false,
      nodePath,
      version: versionText,
      reasonCode: 'cursor.version_insufficient',
      reasonParams: { foundVersion: versionText },
    };
  }

  return {
    available: true,
    nodePath,
    version: versionText,
  };
}

/**
 * Returns cached Node.js availability for the Cursor SDK sidecar.
 *
 * The probe runs `node --version` in a child process; doing so asynchronously
 * keeps it off the event loop so callers on request paths (e.g. the provider
 * settings descriptor endpoint) never block. Concurrent probes are deduped.
 */
export function detectNodeRuntime(options?: { force?: boolean }): Promise<NodeRuntimeStatus> {
  const now = Date.now();
  if (!options?.force && cached && now - cached.checkedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached.status);
  }

  if (!options?.force && inflight) return inflight;

  const probe = probeNodeRuntime()
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

/** Clears the cached Node runtime probe (primarily for tests). */
export function resetNodeRuntimeCache(): void {
  cached = null;
  inflight = null;
}
