import { Type, type Static } from '@sinclair/typebox';

const SecretSourceSchema = Type.Union([
  Type.Literal('bun-secrets'),
  Type.Literal('environment'),
  Type.Literal('config-file'),
  Type.Literal('none'),
]);

const ProviderTypeSchema = Type.Union([
  Type.Literal('gemini'),
  Type.Literal('openai'),
  Type.Literal('openai-compatible'),
  Type.Literal('anthropic'),
]);

export const AddConnectorBodySchema = Type.Object({
  name: Type.String(),
  apiKey: Type.String(),
  source: SecretSourceSchema,
  provider: Type.Optional(ProviderTypeSchema),
  baseUrl: Type.Optional(Type.String()),
  /** Optional OpenAI Organization ID — only meaningful for provider === 'openai'. */
  organizationId: Type.Optional(Type.String()),
  /** Optional OpenAI Project ID — only meaningful for provider === 'openai'. */
  projectId: Type.Optional(Type.String()),
});

export type AddConnectorBody = Static<typeof AddConnectorBodySchema>;

export const UpdateConnectorModelsBodySchema = Type.Object({
  enabledModels: Type.Array(Type.String()),
});

export type UpdateConnectorModelsBody = Static<typeof UpdateConnectorModelsBodySchema>;

/** Loose runtime check schema for ConnectorStatus — connectors array may contain any shape. */
export const ConnectorStatusSchema = Type.Object({
  connectors: Type.Array(Type.Any()),
});
