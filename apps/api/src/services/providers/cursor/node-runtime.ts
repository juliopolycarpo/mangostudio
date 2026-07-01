/**
 * Detects whether Node.js is available for the Cursor SDK sidecar.
 * The Cursor SDK local agent stream requires Node.js >= 22.13 (Bun is unsupported).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13;
const CACHE_TTL_MS = 30_000;

export interface NodeRuntimeStatus {
  available: boolean;
  reason?: string;
  nodePath?: string;
  version?: string;
}

interface NodeRuntimeCache {
  checkedAt: number;
  status: NodeRuntimeStatus;
}

let cached: NodeRuntimeCache | null = null;

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

function resolveNodeBinary(): string | null {
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
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0 && result.stdout) return candidate;
  }

  return null;
}

function probeNodeRuntime(): NodeRuntimeStatus {
  const nodePath = resolveNodeBinary();
  if (!nodePath) {
    return {
      available: false,
      reason: 'You need NodeJS installed to run Cursor SDK Agents. `node` binary not found',
    };
  }

  const result = spawnSync(nodePath, ['--version'], {
    encoding: 'utf8',
    timeout: 2_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0 || !result.stdout) {
    return {
      available: false,
      reason: 'You need NodeJS installed to run Cursor SDK Agents. `node` binary not found',
    };
  }

  const versionText = result.stdout.trim();
  const parsed = parseNodeVersion(versionText);
  if (!parsed || !meetsMinimumVersion(parsed)) {
    return {
      available: false,
      nodePath,
      version: versionText,
      reason: `Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ is required for Cursor SDK Agents (found ${versionText}).`,
    };
  }

  return {
    available: true,
    nodePath,
    version: versionText,
  };
}

/** Returns cached Node.js availability for the Cursor SDK sidecar. */
export function detectNodeRuntime(options?: { force?: boolean }): NodeRuntimeStatus {
  const now = Date.now();
  if (!options?.force && cached && now - cached.checkedAt < CACHE_TTL_MS) {
    return cached.status;
  }

  const status = probeNodeRuntime();
  cached = { checkedAt: now, status };
  return status;
}

/** Clears the cached Node runtime probe (primarily for tests). */
export function resetNodeRuntimeCache(): void {
  cached = null;
}
