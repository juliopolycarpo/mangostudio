import { existsSync } from 'node:fs';
import { getCursorSidecarScriptPath } from '../../../lib/runtime-paths';
import { detectNodeRuntime, type NodeRuntimeStatus } from './node-runtime';

const NODE_RUNTIME_UNAVAILABLE_REASON =
  'You need NodeJS installed to run Cursor SDK Agents. `node` binary not found';

export interface CursorRuntimeStatus extends NodeRuntimeStatus {
  sidecarScriptPath?: string;
}

interface CursorRuntimeAvailabilityOptions {
  sidecarScriptPath?: string;
  sidecarExists?: (path: string) => boolean;
}

export function evaluateCursorRuntimeAvailability(
  nodeRuntime: NodeRuntimeStatus,
  options: CursorRuntimeAvailabilityOptions = {}
): CursorRuntimeStatus {
  if (!nodeRuntime.available) {
    return {
      ...nodeRuntime,
      available: false,
      reason: nodeRuntime.reason ?? NODE_RUNTIME_UNAVAILABLE_REASON,
    };
  }

  const sidecarScriptPath = options.sidecarScriptPath ?? getCursorSidecarScriptPath();
  const sidecarExists = options.sidecarExists ?? existsSync;
  if (!sidecarExists(sidecarScriptPath)) {
    return {
      ...nodeRuntime,
      available: false,
      sidecarScriptPath,
      reason: `Cursor SDK sidecar script is missing at ${sidecarScriptPath}.`,
    };
  }

  return {
    ...nodeRuntime,
    available: true,
    sidecarScriptPath,
  };
}

export async function detectCursorRuntimeAvailability(): Promise<CursorRuntimeStatus> {
  return evaluateCursorRuntimeAvailability(await detectNodeRuntime());
}
