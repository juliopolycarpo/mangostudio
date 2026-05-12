import type { ProviderType } from '../types/provider';

export type ProviderCacheName = 'sdk-client' | 'prepared-runtime' | 'provider-route';

export type ProviderProbeOperation = 'healthcheck' | 'model-list';

export type ObservabilityLogKind = 'probe-timeout';

export interface ProviderCacheMetrics {
  cacheName: ProviderCacheName;
  hits: number;
  misses: number;
  hitRate: number;
}

export interface ProviderProbeMetrics {
  operation: ProviderProbeOperation;
  timeoutCount: number;
}

export interface ProviderObservabilityMetrics {
  provider: ProviderType;
  totalProbeTimeouts: number;
  caches: ReadonlyArray<ProviderCacheMetrics>;
  probeTimeouts: ReadonlyArray<ProviderProbeMetrics>;
}

export interface ProviderObservabilityMetricsResponse {
  generatedAt: number;
  providers: ReadonlyArray<ProviderObservabilityMetrics>;
}

export interface ProviderObservabilityLogEntry {
  id: string;
  timestamp: number;
  provider: ProviderType;
  kind: ObservabilityLogKind;
  operation: ProviderProbeOperation;
  message: string;
}

export interface ProviderObservabilityLogsResponse {
  generatedAt: number;
  entries: ReadonlyArray<ProviderObservabilityLogEntry>;
}
