import { getCursorSidecarScriptPath } from '../../../lib/runtime-paths';
import {
  appendBoundedTail,
  buildNodeSidecarEnv,
  type ChildExitStatus,
  formatNodeSidecarExit,
  type SpawnedNodeSidecarProcess,
  spawnNodeSidecarProcess,
  terminateNodeSidecar,
  terminateNodeSidecarWithEscalation,
  waitForChildExit,
} from '../core/node-sidecar/spawn-sidecar';
import { formatCursorRuntimeUnavailableReason } from './runtime-reason';

/**
 * Version of the NDJSON protocol spoken over the sidecar's stdio. The sidecar
 * announces it in its `ready` handshake line; the runner rejects a mismatch.
 * Must stay in lockstep with PROTOCOL_VERSION in sidecar/run-agent.mjs (the
 * script cannot import this module: both ship inside the same artifact).
 */
export const CURSOR_SIDECAR_PROTOCOL_VERSION = 1;

export type { ChildExitStatus };
export { appendBoundedTail, waitForChildExit };

export interface SpawnCursorSidecarProcessOptions {
  nodePath: string;
  sidecarScriptPath?: string;
  envSource?: NodeJS.ProcessEnv;
}

export type SpawnedCursorSidecarProcess = SpawnedNodeSidecarProcess;

export function resolveCursorSidecarScriptPath(): string {
  return getCursorSidecarScriptPath();
}

export function buildCursorSidecarEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return buildNodeSidecarEnv(source);
}

export function spawnCursorSidecarProcess(
  options: SpawnCursorSidecarProcessOptions
): SpawnedCursorSidecarProcess {
  return spawnNodeSidecarProcess({
    nodePath: options.nodePath,
    sidecarScriptPath: options.sidecarScriptPath ?? resolveCursorSidecarScriptPath(),
    envSource: options.envSource,
    describeSpawnError: describeCursorSpawnError,
  });
}

/**
 * Maps spawn errnos to the same user-readable runtime hints the availability
 * probe produces: a Node binary removed after the 30s probe cache filled
 * (ENOENT) or one that is not executable (EACCES/EPERM) should not surface as
 * a bare errno string in the chat UI.
 */
export function describeCursorSpawnError(
  error: Error & { code?: string },
  nodePath: string
): string {
  if (error.code === 'ENOENT') {
    return formatCursorRuntimeUnavailableReason('cursor.node_not_found');
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return formatCursorRuntimeUnavailableReason('cursor.node_invalid', { nodePath });
  }
  return error.message || 'Failed to start the Cursor sidecar.';
}

export function terminateCursorSidecar(child: Parameters<typeof terminateNodeSidecar>[0]): void {
  terminateNodeSidecar(child);
}

export function terminateCursorSidecarWithEscalation(
  child: Parameters<typeof terminateNodeSidecarWithEscalation>[0],
  childExit: Promise<ChildExitStatus>,
  graceMs: number
): Promise<void> {
  return terminateNodeSidecarWithEscalation(child, childExit, graceMs);
}

export function formatCursorSidecarExit(status: ChildExitStatus): string {
  return formatNodeSidecarExit(status, 'Cursor');
}
