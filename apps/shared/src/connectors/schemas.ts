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

/** One metered rate-limit window (5-hour, weekly, ...) of a ChatGPT plan. */
const ChatGptUsageWindowSchema = Type.Object({
  /** Percentage of the window already consumed (0–100). */
  usedPercent: Type.Number(),
  /** Window length in minutes when the backend reports it. */
  windowMinutes: Type.Optional(Type.Number()),
  /** Unix epoch ms when the window resets. */
  resetsAt: Type.Optional(Type.Number()),
});

/**
 * Point-in-time plan-quota snapshot for a ChatGPT connector. Every field the
 * backend did not report is omitted — the backend contract is unversioned and
 * parsed defensively, so absence never means an error.
 */
export const ChatGptUsageSnapshotSchema = Type.Object({
  planType: Type.Optional(Type.String()),
  primary: Type.Optional(ChatGptUsageWindowSchema),
  secondary: Type.Optional(ChatGptUsageWindowSchema),
  /** Extra metered limits (e.g. model-specific), parsed lossily per element. */
  additionalLimits: Type.Optional(
    Type.Array(
      Type.Object({
        limitName: Type.Optional(Type.String()),
        window: Type.Optional(ChatGptUsageWindowSchema),
      })
    )
  ),
  /** Redeemable rate-limit reset credits. */
  resetCredits: Type.Optional(
    Type.Object({
      availableCount: Type.Number(),
      /** Unix epoch ms of the soonest expiring available credit. */
      nextExpiresAt: Type.Optional(Type.Number()),
    })
  ),
  /** Pay-as-you-go credits. */
  credits: Type.Optional(
    Type.Object({
      hasCredits: Type.Optional(Type.Boolean()),
      unlimited: Type.Optional(Type.Boolean()),
      balance: Type.Optional(Type.Number()),
    })
  ),
  limitReached: Type.Optional(Type.Boolean()),
  /** Unix epoch ms when this snapshot was captured. */
  capturedAt: Type.Number(),
  source: Type.Union([Type.Literal('headers'), Type.Literal('endpoint')]),
});

export type ChatGptUsageSnapshot = Static<typeof ChatGptUsageSnapshotSchema>;

/** Loose runtime check schema for ConnectorStatus — connectors array may contain any shape. */
export const ConnectorStatusSchema = Type.Object({
  connectors: Type.Array(Type.Any()),
});

export const StartChatGptOAuthBodySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  /** Optional existing ChatGPT connector to refresh in place. */
  connectorId: Type.Optional(Type.String({ minLength: 1 })),
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
