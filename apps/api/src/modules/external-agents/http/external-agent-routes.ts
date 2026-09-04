/**
 * Read-only discovery for the runner selector, plus the disclosure record.
 *
 * Discovery answers for one environment at a time: which external agents exist
 * there, whether they are installed and signed in, and what each one can
 * actually do. No turn can be started through this module.
 *
 * The selector does not poll. Environment state changes already publish a
 * user-scoped invalidation on the environments realtime topic — a runtime
 * connecting or dropping, an environment being added, edited or removed — and
 * that is exactly when these answers go stale, so the client refetches on the
 * signal it is already subscribed to.
 *
 * The disclosure endpoints are here rather than beside the turn routes because
 * they are about a *vendor*, not a chat: one acknowledgement covers every chat
 * that will ever use that vendor, and hanging them off a chat id would imply
 * otherwise. Acknowledging needs the descriptor, so it names the environment
 * whose descriptor the user was shown — consent is to what a specific machine
 * said the agent could do, not to the vendor's name in the abstract.
 */

import { EnvironmentIdSchema, LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import {
  type ExternalAccountLimits,
  ExternalAccountLimitsSchema,
  ExternalAgentCommandCatalogResponseSchema,
  type ExternalAgentDescriptor,
  ExternalAgentDescriptorListResponseSchema,
  externalRemedyFor,
  isExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  readCachedExternalAccountLimits,
  refreshExternalAccountLimits,
} from '../application/external-account-limits';
import {
  type DiscoveredExternalAgent,
  type ExternalAgentDiscoveryService,
  externalAgentDiscoveryService,
} from '../application/external-agent-discovery';
import {
  type ExternalCommandCatalogCache,
  externalCommandCatalogCache,
} from '../application/external-command-catalog-cache';
import {
  acknowledgeExternalDisclosure,
  listExternalDisclosures,
  requiresExternalDisclosure,
  revokeExternalDisclosure,
} from '../application/external-disclosure-gate';
import {
  type ExternalSessionManager,
  externalSessionManager,
} from '../application/external-session-manager';

/**
 * Which machine the question is about. Omitted means the hub's own, matching
 * the environment probing routes; anything else names an environment the
 * signed-in user owns, and the probing layer refuses one they do not.
 */
const environmentQuery = t.Object({
  environmentId: t.Optional(EnvironmentIdSchema),
});

const DisclosureRecordSchema = t.Object({
  targetId: t.String({ minLength: 1, maxLength: 64 }),
  disclosureVersion: t.Integer({ minimum: 1 }),
  acknowledgedAt: t.Integer({ minimum: 0 }),
});

const DisclosureListResponseSchema = t.Object({
  disclosures: t.Array(DisclosureRecordSchema, { maxItems: 16 }),
});

const AcknowledgeResponseSchema = t.Object({ acknowledged: t.Literal(true) });
const RevokeResponseSchema = t.Object({ revoked: t.Literal(true) });

const AccountLimitsQuerySchema = t.Object({
  environmentId: t.Optional(EnvironmentIdSchema),
  /** Opaque vendor-account digest; omit when the descriptor has none. */
  vendorAccountFingerprint: t.Optional(t.String({ maxLength: 128 })),
});

const AccountLimitsResponseSchema = t.Object({
  /** Absent means unknown — never fabricate a zero snapshot. */
  limits: t.Optional(ExternalAccountLimitsSchema),
});

export interface ExternalAgentRouteDependencies {
  /**
   * Descriptors *with* their provenance: the disclosure endpoints here are the
   * only callers that must tell an adapter's answer from the cheap pass.
   */
  readonly discovery?: Pick<ExternalAgentDiscoveryService, 'describeExternalAgents'>;
  /** How revocation stops what is already running. */
  readonly sessions?: Pick<ExternalSessionManager, 'reapScope'>;
  /** The same process-wide cache `external-turn-controller.ts` writes on `commands_available`. */
  readonly commandCatalog?: Pick<ExternalCommandCatalogCache, 'read'>;
}

/**
 * The signed-in user, or nothing.
 *
 * `requireAuth` already rejects an unauthenticated request, so this is a second
 * line — but it is not redundant, because the value it replaces was `?? ''`, and
 * an empty user id is not merely useless here: `reapScope` treats a falsy
 * `userId` as "no filter" and would close **every live external session for
 * every user on the hub**. A sentinel that widens a scope has to be refused
 * rather than passed on.
 */
function authenticatedUserId(
  user: { readonly id?: string } | null | undefined
): string | undefined {
  const id = user?.id;
  return id && id.length > 0 ? id : undefined;
}

const UNAUTHENTICATED = {
  error: 'Authentication required.',
  code: ERROR_CODES.UNAUTHORIZED,
} as const;

export function createExternalAgentRoutes(dependencies: ExternalAgentRouteDependencies = {}) {
  const discovery = dependencies.discovery ?? externalAgentDiscoveryService;
  const sessions = dependencies.sessions ?? externalSessionManager;
  const commandCatalog = dependencies.commandCatalog ?? externalCommandCatalogCache;

  return new Elysia()
    .use(requireAuth)
    .get(
      '/external-agents',
      {
        query: environmentQuery,
        response: {
          200: ExternalAgentDescriptorListResponseSchema,
          401: ApiErrorResponseSchema,
        },
      },
      async ({ query, user, set }) => {
        const userId = authenticatedUserId(user);
        if (!userId) {
          set.status = 401;
          return UNAUTHENTICATED;
        }
        const environmentId = query.environmentId ?? LOCAL_ENVIRONMENT_ID;
        // Discovery answers for an environment it could not reach rather than
        // throwing, so there is no failure arm here to write.
        const agents = await discovery.describeExternalAgents({ userId, environmentId });
        return { environmentId, agents: await withDisclosureReasons(userId, agents) };
      }
    )
    .get(
      '/external-agents/disclosures',
      {
        response: {
          200: DisclosureListResponseSchema,
          401: ApiErrorResponseSchema,
        },
      },
      async ({ user, set }) => {
        const userId = authenticatedUserId(user);
        if (!userId) {
          set.status = 401;
          return UNAUTHENTICATED;
        }
        return { disclosures: [...(await listExternalDisclosures(userId, getDb()))] };
      }
    )
    .post(
      '/external-agents/:targetId/disclosure',
      {
        params: t.Object({ targetId: t.String({ minLength: 1, maxLength: 64 }) }),
        query: environmentQuery,
        response: {
          200: AcknowledgeResponseSchema,
          401: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          503: ApiErrorResponseSchema,
        },
      },
      async ({ params, query, user, set }) => {
        const userId = authenticatedUserId(user);
        if (!userId) {
          set.status = 401;
          return UNAUTHENTICATED;
        }
        if (!isExternalAgentTargetId(params.targetId)) {
          set.status = 404;
          return { error: 'Unknown external agent.', code: ERROR_CODES.NOT_FOUND };
        }
        const environmentId = query.environmentId ?? LOCAL_ENVIRONMENT_ID;
        // The one discovery call that waits for the adapter. Everywhere else a
        // cold cache degrades to the cheap pass and the worst case is a selector
        // rendering a stale capability for a few seconds; here it would be
        // written into a consent record that outlives the session, and the
        // placeholder it stored would never match a real answer again.
        const agents = await discovery.describeExternalAgents(
          { userId, environmentId },
          { waitForAdapter: true }
        );
        const agent = agents.find((candidate) => candidate.descriptor.targetId === params.targetId);
        if (!agent || agent.descriptor.unavailableReason) {
          set.status = 404;
          return {
            error: 'This agent is not available on that machine.',
            code: ERROR_CODES.NOT_FOUND,
          };
        }
        if (!agent.adapterAnswered) {
          // The probe was refused, timed out or never started. Recording anyway
          // would store consent to a capability set nobody was shown, so the
          // notice stays unanswered and the client may retry.
          set.status = 503;
          return {
            error: 'Could not confirm what this agent can do on that machine. Try again.',
            code: ERROR_CODES.PROVIDER_ERROR,
          };
        }

        // The fingerprint is derived from this descriptor, never taken from the
        // request. A client that could supply one would be acknowledging a
        // disclosure it was never shown.
        await acknowledgeExternalDisclosure(
          { userId, targetId: params.targetId },
          {
            capabilities: agent.descriptor.capabilities,
            supportedConfigurations: agent.descriptor.supportedConfigurations,
          },
          getDb()
        );
        return { acknowledged: true as const };
      }
    )
    .delete(
      '/external-agents/:targetId/disclosure',
      {
        params: t.Object({ targetId: t.String({ minLength: 1, maxLength: 64 }) }),
        response: {
          200: RevokeResponseSchema,
          401: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
        },
      },
      async ({ params, user, set }) => {
        const userId = authenticatedUserId(user);
        if (!userId) {
          set.status = 401;
          return UNAUTHENTICATED;
        }
        if (!isExternalAgentTargetId(params.targetId)) {
          set.status = 404;
          return { error: 'Unknown external agent.', code: ERROR_CODES.NOT_FOUND };
        }
        await revokeExternalDisclosure({ userId, targetId: params.targetId }, getDb());
        // Blocking the next start is not enough. Revoking while a vendor process
        // is mid-turn would leave the exact thing the user just refused still
        // running, so live sessions go with the row — continuation is kept,
        // because the conversation is still theirs if they acknowledge again.
        //
        // Scoped to the vendor that was withdrawn, not to the user. The
        // acknowledgement is per company by design, and reaping the whole user
        // would kill an unrelated Codex or Cursor turn on a consent nobody
        // touched.
        await sessions.reapScope({ userId, targetId: params.targetId }, 'consent-revoked', {
          keepContinuation: true,
        });
        return { revoked: true as const };
      }
    )
    .get(
      '/external-agents/:targetId/account-limits',
      {
        params: t.Object({ targetId: t.String({ minLength: 1, maxLength: 64 }) }),
        query: AccountLimitsQuerySchema,
        response: {
          200: AccountLimitsResponseSchema,
          401: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
        },
      },
      async ({ params, query, user, set }) => {
        const userId = authenticatedUserId(user);
        if (!userId) {
          set.status = 401;
          return UNAUTHENTICATED;
        }
        if (!isExternalAgentTargetId(params.targetId)) {
          set.status = 404;
          return { error: 'Unknown external agent.', code: ERROR_CODES.NOT_FOUND };
        }
        const environmentId = query.environmentId ?? LOCAL_ENVIRONMENT_ID;
        const limits = await readCachedExternalAccountLimits({
          userId,
          environmentId,
          targetId: params.targetId,
          vendorAccountFingerprint: query.vendorAccountFingerprint ?? null,
        });
        return limits ? { limits } : {};
      }
    )
    .post(
      '/external-agents/:targetId/account-limits/refresh',
      {
        params: t.Object({ targetId: t.String({ minLength: 1, maxLength: 64 }) }),
        query: AccountLimitsQuerySchema,
        response: {
          200: AccountLimitsResponseSchema,
          401: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
        },
      },
      async ({ params, query, user, set }) => {
        const userId = authenticatedUserId(user);
        if (!userId) {
          set.status = 401;
          return UNAUTHENTICATED;
        }
        if (!isExternalAgentTargetId(params.targetId)) {
          set.status = 404;
          return { error: 'Unknown external agent.', code: ERROR_CODES.NOT_FOUND };
        }
        const environmentId = query.environmentId ?? LOCAL_ENVIRONMENT_ID;
        // Short-lived probe when no live session is named — see application layer.
        const limits: ExternalAccountLimits | undefined = await refreshExternalAccountLimits({
          userId,
          environmentId,
          targetId: params.targetId,
          vendorAccountFingerprint: query.vendorAccountFingerprint ?? null,
        });
        return limits ? { limits } : {};
      }
    )
    .get(
      '/external-agents/:targetId/commands',
      {
        params: t.Object({ targetId: t.String({ minLength: 1, maxLength: 64 }) }),
        query: environmentQuery,
        response: {
          200: ExternalAgentCommandCatalogResponseSchema,
          401: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
        },
      },
      ({ params, query, user, set }) => {
        const userId = authenticatedUserId(user);
        if (!userId) {
          set.status = 401;
          return UNAUTHENTICATED;
        }
        if (!isExternalAgentTargetId(params.targetId)) {
          set.status = 404;
          return { error: 'Unknown external agent.', code: ERROR_CODES.NOT_FOUND };
        }
        const environmentId = query.environmentId ?? LOCAL_ENVIRONMENT_ID;
        // Absent means nothing has been observed for this key yet, which is not
        // a 404: the hint is legitimately empty, not addressed to an unknown
        // agent — `isExternalAgentTargetId` above already refused that.
        const commands =
          commandCatalog.read({ userId, environmentId, targetId: params.targetId }) ?? [];
        return { commands };
      }
    );
}

/**
 * Marks descriptors the user has not acknowledged, so the selector can prompt.
 *
 * Advisory. The authoritative refusal is at turn start, and it has to be: this
 * answer is cached per (user, environment) and an acknowledgement can be revoked
 * from another tab while a stale descriptor is still on screen.
 *
 * A descriptor that is already unavailable keeps its own reason. "Not installed"
 * and "signed out" are both nearer the front of the queue than a disclosure the
 * user cannot act on until the agent exists at all.
 */
async function withDisclosureReasons(
  userId: string,
  agents: readonly DiscoveredExternalAgent[]
): Promise<readonly ExternalAgentDescriptor[]> {
  const db = getDb();
  return await Promise.all(
    agents.map(async ({ descriptor, adapterAnswered }) => {
      if (descriptor.unavailableReason || !descriptor.installed) return descriptor;
      const required = await requiresExternalDisclosure(
        { userId, targetId: descriptor.targetId },
        // Only an adapter's answer describes this vendor. On the cheap pass the
        // capability set is a placeholder, and comparing a stored fingerprint
        // against it would put the notice back in front of every user on every
        // cold cache — which is a reload, a sign-in or a runtime reconnect.
        adapterAnswered
          ? {
              capabilities: descriptor.capabilities,
              supportedConfigurations: descriptor.supportedConfigurations,
            }
          : null,
        db
      );
      if (!required) return descriptor;
      // The remedy travels with the reason, always — `ExternalAgentDescriptor`
      // says it is absent exactly when the reason is. Stamping a reason here
      // without the matching remedy would leave the one row whose fix is a
      // dialog this app already owns with nothing to click.
      const remedy = externalRemedyFor('disclosure-required');
      return {
        ...descriptor,
        unavailableReason: 'disclosure-required' as const,
        ...(remedy ? { remedy } : {}),
      };
    })
  );
}

export const externalAgentRoutes = createExternalAgentRoutes();
