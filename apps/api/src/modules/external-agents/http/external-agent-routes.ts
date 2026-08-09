/**
 * Read-only discovery for the runner selector.
 *
 * One endpoint, auth-required, answering for one environment at a time: which
 * external agents exist there, whether they are installed and signed in, and
 * what each one can actually do. No turn can be started through this module.
 *
 * The selector does not poll. Environment state changes already publish a
 * user-scoped invalidation on the environments realtime topic — a runtime
 * connecting or dropping, an environment being added, edited or removed — and
 * that is exactly when these answers go stale, so the client refetches on the
 * signal it is already subscribed to.
 */

import { EnvironmentIdSchema, LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { ApiErrorResponseSchema } from '@mangostudio/shared/errors';
import {
  type ExternalAgentDescriptorListResponse,
  ExternalAgentDescriptorListResponseSchema,
} from '@mangostudio/shared/external-agents';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  type ExternalAgentDiscoveryService,
  externalAgentDiscoveryService,
} from '../application/external-agent-discovery';

/**
 * Which machine the question is about. Omitted means the hub's own, matching
 * the environment probing routes; anything else names an environment the
 * signed-in user owns, and the probing layer refuses one they do not.
 */
const environmentQuery = t.Object({
  environmentId: t.Optional(EnvironmentIdSchema),
});

export function createExternalAgentRoutes(
  discovery: ExternalAgentDiscoveryService = externalAgentDiscoveryService
) {
  return new Elysia().use(requireAuth).get(
    '/external-agents',
    async ({ query, user }): Promise<ExternalAgentDescriptorListResponse> => {
      const environmentId = query.environmentId ?? LOCAL_ENVIRONMENT_ID;
      // Discovery answers for an environment it could not reach rather than
      // throwing, so there is no failure arm here to write.
      const agents = await discovery.listExternalAgents({
        userId: user?.id ?? '',
        environmentId,
      });
      return { environmentId, agents };
    },
    {
      query: environmentQuery,
      response: {
        200: ExternalAgentDescriptorListResponseSchema,
        401: ApiErrorResponseSchema,
      },
    }
  );
}

export const externalAgentRoutes = createExternalAgentRoutes();
