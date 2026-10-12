import type { ExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import { publishExternalAgentsInvalidation } from '../../../services/realtime/external-agents-invalidation';
import {
  type ExternalAgentDiscoveryService,
  externalAgentDiscoveryService,
} from './external-agent-discovery';

export interface SignedOutScope {
  readonly userId: string;
  readonly environmentId: string;
  readonly targetId: ExternalAgentTargetId;
}

/**
 * Builds the reaction to a turn that ended because the vendor account is signed out: drop the
 * cached discovery answer for the environment, then ask the owner's clients to refetch it.
 *
 * One shot per turn, so it cannot loop: the refetch re-probes the vendor and the probe's own
 * verdict is what the app then shows. The hub keeps no signed-out flag of its own, so an agent
 * whose probe still says signed in (or cannot tell) is shown as the probe says.
 *
 * @example
 * const invalidate = createSignedOutInvalidation(discovery, publishExternalAgentsInvalidation);
 * invalidate({ userId: 'u1', environmentId: 'local', targetId: 'cursor' });
 */
export function createSignedOutInvalidation(
  discovery: Pick<ExternalAgentDiscoveryService, 'resetCache'>,
  publish: (userId: string) => void
): (scope: SignedOutScope) => void {
  return (scope) => {
    discovery.resetCache(scope.environmentId, scope.userId);
    publish(scope.userId);
  };
}

export const invalidateDiscoveryAfterSignedOut = createSignedOutInvalidation(
  externalAgentDiscoveryService,
  publishExternalAgentsInvalidation
);
