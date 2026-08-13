import Type, { type Static } from 'typebox';
import { ProviderTypeSchema } from '../provider-settings/schemas';
import { ReadonlyArraySchema } from '../schema-helpers';

export const ProviderCacheNameSchema = Type.Union([
  Type.Literal('sdk-client'),
  Type.Literal('prepared-runtime'),
  Type.Literal('provider-route'),
]);

export type ProviderCacheName = Static<typeof ProviderCacheNameSchema>;

export const ProviderProbeOperationSchema = Type.Union([
  Type.Literal('healthcheck'),
  Type.Literal('model-list'),
]);

export type ProviderProbeOperation = Static<typeof ProviderProbeOperationSchema>;

export const ObservabilityLogKindSchema = Type.Literal('probe-timeout');

export type ObservabilityLogKind = Static<typeof ObservabilityLogKindSchema>;

export const ProviderCacheMetricsSchema = Type.Object({
  cacheName: ProviderCacheNameSchema,
  hits: Type.Number(),
  misses: Type.Number(),
  hitRate: Type.Number(),
});

export type ProviderCacheMetrics = Static<typeof ProviderCacheMetricsSchema>;

export const ProviderProbeMetricsSchema = Type.Object({
  operation: ProviderProbeOperationSchema,
  timeoutCount: Type.Number(),
});

export type ProviderProbeMetrics = Static<typeof ProviderProbeMetricsSchema>;

export const ProviderUsageKindSchema = Type.Union([Type.Literal('text'), Type.Literal('image')]);

export type ProviderUsageKind = Static<typeof ProviderUsageKindSchema>;

export const ProviderUsageMetricsSchema = Type.Object({
  textTurns: Type.Number(),
  imageGenerations: Type.Number(),
  inputTokens: Type.Number(),
  lastUsedAt: Type.Optional(Type.Number()),
});

export type ProviderUsageMetrics = Static<typeof ProviderUsageMetricsSchema>;

export const ProviderDeprecationMetricsSchema = Type.Object({
  /** Turns refused by the deprecation guard since the counter was last reset. */
  refusedTurns: Type.Number(),
  /** Unix epoch ms of the most recent refusal. */
  lastAttemptedAt: Type.Number(),
  /** The stored model id of that refusal — what a chat is still pointing at. */
  lastModelId: Type.Optional(Type.String()),
});

export type ProviderDeprecationMetrics = Static<typeof ProviderDeprecationMetricsSchema>;

export const ProviderObservabilityMetricsSchema = Type.Object({
  provider: ProviderTypeSchema,
  totalProbeTimeouts: Type.Number(),
  caches: ReadonlyArraySchema(ProviderCacheMetricsSchema),
  probeTimeouts: ReadonlyArraySchema(ProviderProbeMetricsSchema),
  usage: Type.Optional(ProviderUsageMetricsSchema),
  /**
   * Turns refused because this provider is deprecated.
   *
   * The only evidence that says whether a deprecation window has actually
   * elapsed for anyone: a counter that stays at zero across a release is what
   * makes "nobody is still using it" checkable rather than asserted. Absent
   * until the first refusal, so a provider that was never deprecated reads as
   * silent rather than as zero.
   */
  deprecatedAttempts: Type.Optional(ProviderDeprecationMetricsSchema),
});

export type ProviderObservabilityMetrics = Static<typeof ProviderObservabilityMetricsSchema>;

export const ProviderObservabilityMetricsResponseSchema = Type.Object({
  generatedAt: Type.Number(),
  providers: ReadonlyArraySchema(ProviderObservabilityMetricsSchema),
});

export type ProviderObservabilityMetricsResponse = Static<
  typeof ProviderObservabilityMetricsResponseSchema
>;

export const ProviderObservabilityLogEntrySchema = Type.Object({
  id: Type.String(),
  timestamp: Type.Number(),
  provider: ProviderTypeSchema,
  kind: ObservabilityLogKindSchema,
  operation: ProviderProbeOperationSchema,
  message: Type.String(),
});

export type ProviderObservabilityLogEntry = Static<typeof ProviderObservabilityLogEntrySchema>;

export const ProviderObservabilityLogsResponseSchema = Type.Object({
  generatedAt: Type.Number(),
  entries: ReadonlyArraySchema(ProviderObservabilityLogEntrySchema),
});

export type ProviderObservabilityLogsResponse = Static<
  typeof ProviderObservabilityLogsResponseSchema
>;
