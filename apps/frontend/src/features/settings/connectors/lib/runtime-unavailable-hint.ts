import type { Messages } from '@mangostudio/shared/i18n';
import {
  CURSOR_MIN_NODE_VERSION,
  type ProviderRuntimeUnavailableReason,
  type ProviderRuntimeUnavailableReasonParams,
} from '@mangostudio/shared/provider-settings';

export function formatConnectorRuntimeUnavailableHint(
  reason: ProviderRuntimeUnavailableReason | undefined,
  params: ProviderRuntimeUnavailableReasonParams | undefined,
  connectors: Messages['settings']['connectors']
): string | undefined {
  switch (reason) {
    case 'cursor.node_not_found':
      return `${connectors.cursorNodeRequired} ${connectors.cursorNodeNotFound}`;
    case 'cursor.node_invalid':
      return connectors.cursorNodeInvalid.replace('{path}', params?.nodePath ?? '?');
    case 'cursor.version_insufficient':
      return connectors.cursorNodeVersionInsufficient
        .replace('{minVersion}', CURSOR_MIN_NODE_VERSION)
        .replace('{version}', params?.foundVersion ?? '?');
    case 'cursor.sidecar_missing':
      return params?.sidecarPath
        ? connectors.cursorSidecarMissingAt.replace('{path}', params.sidecarPath)
        : connectors.cursorSidecarMissing;
    case 'cursor.sdk_missing':
      return params?.sidecarPath
        ? connectors.cursorSdkMissingAt.replace('{path}', params.sidecarPath)
        : connectors.cursorSdkMissing;
    case 'cursor.sdk_incomplete':
      return params?.sidecarPath
        ? connectors.cursorSdkIncompleteAt.replace('{path}', params.sidecarPath)
        : connectors.cursorSdkIncomplete;
    case 'cursor.native_runtime_missing':
      return params?.packageName
        ? connectors.cursorNativeRuntimeMissingPackage.replace('{packageName}', params.packageName)
        : connectors.cursorNativeRuntimeMissing;
    default:
      return undefined;
  }
}
