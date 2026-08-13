import Type, { type Static } from 'typebox';
import { ProviderTypeSchema } from '../provider-settings/schemas';

/** Runtime state of the cached model catalog. */
export const ModelCatalogStatusSchema = Type.Union([
  Type.Literal('idle'),
  Type.Literal('loading'),
  Type.Literal('ready'),
  Type.Literal('error'),
]);

export type ModelCatalogStatus = Static<typeof ModelCatalogStatusSchema>;

/** Provider capabilities for a model. */
export const ModelCapabilitiesSchema = Type.Object({
  text: Type.Boolean(),
  image: Type.Boolean(),
  streaming: Type.Boolean(),
  reasoning: Type.Optional(Type.Boolean()),
  tools: Type.Optional(Type.Boolean()),
  /** Provider runs its own agent tool loop (not MangoStudio-managed tools). */
  internalAgentTools: Type.Optional(Type.Boolean()),
  statefulContinuation: Type.Optional(Type.Boolean()),
  promptCaching: Type.Optional(Type.Boolean()),
  parallelToolCalls: Type.Optional(Type.Boolean()),
  reasoningWithTools: Type.Optional(Type.Boolean()),
  structuredOutput: Type.Optional(Type.Boolean()),
  fileAttachments: Type.Optional(Type.Boolean()),
  imageInput: Type.Optional(Type.Boolean()),
  pdfInput: Type.Optional(Type.Boolean()),
  textFileInput: Type.Optional(Type.Boolean()),
});

export type ModelCapabilities = Static<typeof ModelCapabilitiesSchema>;

/** A UI-safe model option discovered from a provider. */
export const ModelOptionSchema = Type.Object({
  modelId: Type.String(),
  resourceName: Type.String(),
  displayName: Type.String(),
  description: Type.Optional(Type.String()),
  version: Type.Optional(Type.String()),
  supportedActions: Type.Array(Type.String()),
  provider: Type.Optional(ProviderTypeSchema),
  capabilities: Type.Optional(ModelCapabilitiesSchema),
  /** Maximum input tokens accepted by the model (from provider API). */
  inputTokenLimit: Type.Optional(Type.Number()),
});

export type ModelOption = Static<typeof ModelOptionSchema>;

/** Cached model catalog returned by the API settings route. */
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
