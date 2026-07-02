import { existsSync } from 'node:fs';
import type { ProviderRuntimeUnavailableReasonParams } from '@mangostudio/shared/provider-settings';
import { getCursorSidecarScriptPath } from '../../../lib/runtime-paths';
import { detectNodeRuntime, type NodeRuntimeStatus } from './node-runtime';

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
      reasonCode: nodeRuntime.reasonCode ?? 'cursor.node_not_found',
    };
  }

  const sidecarScriptPath = options.sidecarScriptPath ?? getCursorSidecarScriptPath();
  const sidecarExists = options.sidecarExists ?? existsSync;
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

  return {
    ...nodeRuntime,
    available: true,
    sidecarScriptPath,
  };
}

export async function detectCursorRuntimeAvailability(): Promise<CursorRuntimeStatus> {
  return evaluateCursorRuntimeAvailability(await detectNodeRuntime());
}
