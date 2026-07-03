import { type Static, Type } from '@sinclair/typebox';
import { ProviderTypeSchema } from '../provider-settings/schemas';

const SecretSourceSchema = Type.Union([
  Type.Literal('bun-secrets'),
  Type.Literal('environment'),
  Type.Literal('config-file'),
  Type.Literal('none'),
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

export const StartChatGptOAuthBodySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
});

export type StartChatGptOAuthBody = Static<typeof StartChatGptOAuthBodySchema>;

export const StartChatGptOAuthResponseSchema = Type.Object({
  sessionId: Type.String(),
  authorizeUrl: Type.String(),
  /** Unix epoch ms when the OAuth session (and its loopback server) expires. */
  expiresAt: Type.Number(),
});

export type StartChatGptOAuthResponse = Static<typeof StartChatGptOAuthResponseSchema>;

export const ChatGptOAuthStatusSchema = Type.Object({
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('expired'),
  ]),
  /** Present when status === 'completed'. */
  connectorId: Type.Optional(Type.String()),
  /** Human-readable failure detail, present when status === 'failed'. */
  error: Type.Optional(Type.String()),
  /** Machine-readable failure code, present when status === 'failed'. */
  errorCode: Type.Optional(Type.String()),
});

export type ChatGptOAuthStatus = Static<typeof ChatGptOAuthStatusSchema>;
