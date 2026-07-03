import type { ProviderType, SecretMetadataRow } from '../types/provider';
import type { ChatGptUsageSnapshot } from './schemas';

/** Represents a validated and configured API connector. */
export interface Connector
  extends Omit<SecretMetadataRow, 'configured' | 'enabledModels' | 'provider'> {
  provider: ProviderType;
  configured: boolean;
  enabledModels: string[];
  userId: string | null;
  /** UI-safe account label for OAuth-backed connectors. */
  accountLabel?: string | null;
  /** Provider-specific subscription plan label when known. */
  planType?: string | null;
  /** True when the connector must be signed in again before use. */
  needsReauth?: boolean;
  /** Latest plan-quota snapshot for ChatGPT connectors, when one was captured. */
  usage?: ChatGptUsageSnapshot | null;
}

/** Current runtime-safe status for configured connectors. */
export interface ConnectorStatus {
  connectors: Connector[];
}

/** Response for DELETE /api/settings/connectors/:id */
export interface DeleteConnectorResponse {
  success: true;
}

// Re-export from schemas for convenience
export type { AddConnectorBody, UpdateConnectorModelsBody } from './schemas';
