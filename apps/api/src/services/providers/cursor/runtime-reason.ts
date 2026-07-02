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
    case 'cursor.node_invalid':
      return `The configured Node.js binary at ${params?.nodePath ?? 'unknown path'} is not runnable. Fix or remove MANGO_NODE_PATH / cursor.node_path.`;
    case 'cursor.version_insufficient':
      return `Node.js ${CURSOR_MIN_NODE_VERSION}+ is required for Cursor SDK Agents (found ${params?.foundVersion ?? 'unknown'}).`;
    case 'cursor.sidecar_missing':
      return `Cursor SDK sidecar script is missing at ${params?.sidecarPath ?? 'unknown path'}.`;
    case 'cursor.sdk_missing':
      return `Cursor SDK package is missing from the sidecar at ${params?.sidecarPath ?? 'unknown path'}. Reinstall MangoStudio.`;
    case 'cursor.sdk_incomplete':
      return `Cursor SDK package is incomplete at ${params?.sidecarPath ?? 'unknown path'}. Reinstall MangoStudio.`;
    case 'cursor.native_runtime_missing':
      if (params?.packageName) {
        return `Cursor native runtime package ${params.packageName} is missing. Reinstall MangoStudio.`;
      }
      return 'This platform has no Cursor native runtime in the sidecar. Reinstall MangoStudio.';
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
