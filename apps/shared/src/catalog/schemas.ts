import { Type, type Static } from '@sinclair/typebox';

export const ModelCatalogStatusSchema = Type.Union([
  Type.Literal('idle'),
  Type.Literal('loading'),
  Type.Literal('ready'),
  Type.Literal('error'),
]);

export type ModelCatalogStatus = Static<typeof ModelCatalogStatusSchema>;

export const ModelCapabilitiesSchema = Type.Object({
  text: Type.Boolean(),
  image: Type.Boolean(),
  streaming: Type.Boolean(),
  reasoning: Type.Optional(Type.Boolean()),
  tools: Type.Optional(Type.Boolean()),
  statefulContinuation: Type.Optional(Type.Boolean()),
  promptCaching: Type.Optional(Type.Boolean()),
  parallelToolCalls: Type.Optional(Type.Boolean()),
  reasoningWithTools: Type.Optional(Type.Boolean()),
});

export type ModelCapabilities = Static<typeof ModelCapabilitiesSchema>;

export const ModelOptionSchema = Type.Object({
  modelId: Type.String(),
  resourceName: Type.String(),
  displayName: Type.String(),
  description: Type.Optional(Type.String()),
  version: Type.Optional(Type.String()),
  supportedActions: Type.Array(Type.String()),
  provider: Type.Optional(Type.String()),
  capabilities: Type.Optional(ModelCapabilitiesSchema),
  inputTokenLimit: Type.Optional(Type.Number()),
});

export type ModelOption = Static<typeof ModelOptionSchema>;

export const ModelCatalogResponseSchema = Type.Object({
  configured: Type.Boolean(),
  status: ModelCatalogStatusSchema,
  lastSyncedAt: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
  allModels: Type.Array(ModelOptionSchema),
  textModels: Type.Array(ModelOptionSchema),
  imageModels: Type.Array(ModelOptionSchema),
  discoveredTextModels: Type.Array(ModelOptionSchema),
  discoveredImageModels: Type.Array(ModelOptionSchema),
});

export type ModelCatalogResponse = Static<typeof ModelCatalogResponseSchema>;
