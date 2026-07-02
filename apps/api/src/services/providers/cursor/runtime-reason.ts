import {
  CURSOR_MIN_NODE_VERSION,
  type ProviderRuntimeUnavailableReason,
  type ProviderRuntimeUnavailableReasonParams,
} from '@mangostudio/shared/provider-settings';

export function formatCursorRuntimeUnavailableReason(
  reasonCode: ProviderRuntimeUnavailableReason,
  params?: ProviderRuntimeUnavailableReasonParams
): string {
  switch (reasonCode) {
    case 'cursor.node_not_found':
      return 'You need NodeJS installed to run Cursor SDK Agents. `node` binary not found';
    case 'cursor.version_insufficient':
      return `Node.js ${CURSOR_MIN_NODE_VERSION}+ is required for Cursor SDK Agents (found ${params?.foundVersion ?? 'unknown'}).`;
    case 'cursor.sidecar_missing':
      return `Cursor SDK sidecar script is missing at ${params?.sidecarPath ?? 'unknown path'}.`;
  }
}

export function resolveCursorRuntimeUnavailableMessage(runtime: {
  reasonCode?: ProviderRuntimeUnavailableReason;
  reasonParams?: ProviderRuntimeUnavailableReasonParams;
}): string {
  if (runtime.reasonCode) {
    return formatCursorRuntimeUnavailableReason(runtime.reasonCode, runtime.reasonParams);
  }
  return 'Node.js is required for Cursor SDK agents.';
}
