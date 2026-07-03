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
  /** Occasional plan/announcement blurb from the `x-codex-promo-message` header. */
  promoMessage: Type.Optional(Type.String()),
  /** Unix epoch ms when this snapshot was captured. */
  capturedAt: Type.Number(),
  source: Type.Union([Type.Literal('headers'), Type.Literal('endpoint')]),
});

export type ChatGptUsageSnapshot = Static<typeof ChatGptUsageSnapshotSchema>;

/** Which metered rate-limit window of a ChatGPT plan a usage sample belongs to. */
export const ChatGptUsageWindowKeySchema = Type.Union([
  Type.Literal('primary'),
  Type.Literal('secondary'),
]);

export type ChatGptUsageWindowKey = Static<typeof ChatGptUsageWindowKeySchema>;

/** One persisted point of a window's used-percent series. */
export const ChatGptUsageSampleSchema = Type.Object({
  /** Percentage of the window already consumed (0–100). */
  usedPercent: Type.Number(),
  /** Window length in minutes when the backend reported it. */
  windowMinutes: Type.Optional(Type.Number()),
  /** Unix epoch ms when the window resets, when the backend reported it. */
  resetsAt: Type.Optional(Type.Number()),
  /** Unix epoch ms when this sample was captured. */
  sampledAt: Type.Number(),
});

export type ChatGptUsageSample = Static<typeof ChatGptUsageSampleSchema>;

export const ChatGptUsageHistoryResponseSchema = Type.Object({
  window: ChatGptUsageWindowKeySchema,
  /** Number of days of history the response covers. */
  days: Type.Number(),
  /** Samples ascending by `sampledAt`; empty when nothing was recorded yet. */
  samples: Type.Array(ChatGptUsageSampleSchema),
});

export type ChatGptUsageHistoryResponse = Static<typeof ChatGptUsageHistoryResponseSchema>;

/** Backend outcome of consuming a rate-limit reset credit. */
export const ChatGptRedeemOutcomeSchema = Type.Union([
  Type.Literal('reset'),
  Type.Literal('nothing_to_reset'),
  Type.Literal('no_credit'),
  Type.Literal('already_redeemed'),
]);

export type ChatGptRedeemOutcome = Static<typeof ChatGptRedeemOutcomeSchema>;

export const RedeemChatGptResetCreditBodySchema = Type.Object({
  /**
   * Client-generated idempotency key. Retries of the same confirmed click
   * must reuse it so a network retry can never double-spend a credit.
   */
  redeemRequestId: Type.String({ minLength: 1 }),
});

export type RedeemChatGptResetCreditBody = Static<typeof RedeemChatGptResetCreditBodySchema>;

export const RedeemChatGptResetCreditResponseSchema = Type.Object({
  code: ChatGptRedeemOutcomeSchema,
  /** Number of rate-limit windows the redemption restored. */
  windowsReset: Type.Number(),
});

export type RedeemChatGptResetCreditResponse = Static<
  typeof RedeemChatGptResetCreditResponseSchema
>;

/**
 * Token-usage profile stats for a ChatGPT account. Every field the backend
 * did not report is omitted — the contract is unversioned and parsed
 * defensively, so absence never means an error.
 */
export const ChatGptUsageStatsSchema = Type.Object({
  lifetimeTokens: Type.Optional(Type.Number()),
  peakDailyTokens: Type.Optional(Type.Number()),
  longestRunningTurnSec: Type.Optional(Type.Number()),
  currentStreakDays: Type.Optional(Type.Number()),
  longestStreakDays: Type.Optional(Type.Number()),
  /** Per-day token buckets, ascending by date. */
  dailyUsage: Type.Optional(
    Type.Array(
      Type.Object({
        /** ISO date (YYYY-MM-DD) the bucket starts on. */
        startDate: Type.String(),
        tokens: Type.Number(),
      })
    )
  ),
});

export type ChatGptUsageStats = Static<typeof ChatGptUsageStatsSchema>;

export const ChatGptUsageStatsResponseSchema = Type.Object({
  /** Null when the backend reported no stats (panel shows its empty state). */
  stats: Type.Union([ChatGptUsageStatsSchema, Type.Null()]),
});

export type ChatGptUsageStatsResponse = Static<typeof ChatGptUsageStatsResponseSchema>;

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
