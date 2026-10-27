import type { ExternalAgentTargetId } from '@mangostudio/shared/external-agents';

import { publishExternalAgentsInvalidation } from '../../../services/realtime/external-agents-invalidation';
import {
  type ExternalAgentDiscoveryService,
  externalAgentDiscoveryService,
} from './external-agent-discovery';

export interface StaleDiscoveryScope {
  readonly userId: string;
  readonly environmentId: string;
  readonly targetId: ExternalAgentTargetId;
}

/**
 * Builds the reaction to a refusal that shows the cached discovery answer is stale: a turn that
 * ended signed out, or a session open the runtime refused because the agent is signed out, gone,
 * outdated, or because consent was withdrawn. It drops the cached discovery answer for the
 * environment, then asks the owner's clients to refetch it.
 *
 * One shot per refusal, so it cannot loop: the refetch re-probes the vendor and the probe's own
 * verdict is what the app then shows. The hub keeps no flag of its own, so an agent whose probe
 * still says it is fine (or cannot tell) is shown as the probe says.
 *
 * @example
 * const invalidate = createDiscoveryInvalidation(discovery, publishExternalAgentsInvalidation);
 * invalidate({ userId: 'u1', environmentId: 'local', targetId: 'cursor' });
 */
export function createDiscoveryInvalidation(
  discovery: Pick<ExternalAgentDiscoveryService, 'resetCache'>,
  publish: (userId: string) => void
): (scope: StaleDiscoveryScope) => void {
  return (scope) => {
    discovery.resetCache(scope.environmentId, scope.userId);
    publish(scope.userId);
  };
}

export const invalidateStaleDiscovery = createDiscoveryInvalidation(
  externalAgentDiscoveryService,
  publishExternalAgentsInvalidation
);
