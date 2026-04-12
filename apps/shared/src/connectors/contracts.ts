import type { ProviderType, SecretMetadataRow } from '../types/provider';

/** Represents a validated and configured API connector. */
export interface Connector extends Omit<
  SecretMetadataRow,
  'configured' | 'enabledModels' | 'provider'
> {
  provider: ProviderType;
  configured: boolean;
  enabledModels: string[];
  userId: string | null;
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
