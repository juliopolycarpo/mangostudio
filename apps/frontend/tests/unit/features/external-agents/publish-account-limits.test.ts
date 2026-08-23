/**
 * Filing a quota snapshot that arrived on a turn's stream.
 *
 * The interesting part is not that it writes — it is *where*. The cache key is
 * an account identity, the chunk only names a target, and getting that wrong
 * paints one account's allowance onto another's readout.
 */

import { describe, expect, it } from 'bun:test';
import type {
  ExternalAccountLimits,
  ExternalAgentDescriptor,
  ExternalAgentDescriptorListResponse,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { QueryClient } from '@tanstack/react-query';
import {
  externalAccountLimitsKey,
  externalAgentKeys,
  publishExternalAccountLimits,
} from '@/features/external-agents/queries';

const ENVIRONMENT_ID = 'local';
const OBSERVED_AT = 1_787_000_000_000;

function descriptorFor(fingerprint: string): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId: ENVIRONMENT_ID,
    installed: true,
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    account: { fingerprint },
  } as unknown as ExternalAgentDescriptor;
}

const SIGNED_IN = descriptorFor('account-a');
const OTHER_ACCOUNT = descriptorFor('account-b');

function limitsFixture(usedPercent: number, observedAtMs = OBSERVED_AT): ExternalAccountLimits {
  return { targetId: 'codex', windows: [{ usedPercent }], observedAtMs };
}

function clientWithAgents(agents: ExternalAgentDescriptor[]): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData<ExternalAgentDescriptorListResponse>(
    externalAgentKeys.byEnvironment(ENVIRONMENT_ID),
    { environmentId: ENVIRONMENT_ID, agents }
  );
  return queryClient;
}

/**
 * Annotated on the way out: `getQueryData` on a bare key is `unknown`, and
 * `bun-types` shapes `toEqual` against the *received* type — so an unannotated
 * read makes every expectation below a type error rather than an assertion.
 */
function cachedFor(
  queryClient: QueryClient,
  descriptor: ExternalAgentDescriptor
): ExternalAccountLimits | null | undefined {
  return queryClient.getQueryData<ExternalAccountLimits | null>(
    externalAccountLimitsKey(descriptor)
  );
}

describe('publishExternalAccountLimits', () => {
  it('seeds an entry the header never got to read', () => {
    const queryClient = clientWithAgents([SIGNED_IN]);
    publishExternalAccountLimits(queryClient, ENVIRONMENT_ID, limitsFixture(60));
    expect(cachedFor(queryClient, SIGNED_IN)).toEqual(limitsFixture(60));
  });

  it('replaces a cold read that answered "no snapshot"', () => {
    const queryClient = clientWithAgents([SIGNED_IN]);
    queryClient.setQueryData(externalAccountLimitsKey(SIGNED_IN), null);
    publishExternalAccountLimits(queryClient, ENVIRONMENT_ID, limitsFixture(60));
    expect(cachedFor(queryClient, SIGNED_IN)).toEqual(limitsFixture(60));
  });

  it('leaves a newer snapshot alone', () => {
    const queryClient = clientWithAgents([SIGNED_IN]);
    const newer = limitsFixture(10, OBSERVED_AT + 60_000);
    queryClient.setQueryData(externalAccountLimitsKey(SIGNED_IN), newer);
    // A manual refresh that landed while the turn was still streaming: the
    // stream's reading is older, and older never wins.
    publishExternalAccountLimits(queryClient, ENVIRONMENT_ID, limitsFixture(60));
    expect(cachedFor(queryClient, SIGNED_IN)).toEqual(newer);
  });

  it('writes under the signed-in account, never another one', () => {
    const queryClient = clientWithAgents([SIGNED_IN]);
    const stale = limitsFixture(99, OBSERVED_AT - 60_000);
    // Left over from before the user switched accounts on this machine.
    queryClient.setQueryData(externalAccountLimitsKey(OTHER_ACCOUNT), stale);
    publishExternalAccountLimits(queryClient, ENVIRONMENT_ID, limitsFixture(60));
    expect(cachedFor(queryClient, OTHER_ACCOUNT)).toEqual(stale);
    expect(cachedFor(queryClient, SIGNED_IN)).toEqual(limitsFixture(60));
  });

  it('drops the snapshot when the account it belongs to is unknown', () => {
    // No descriptor list means nothing on screen is reading this target's quota,
    // and there is no fingerprint to key the write by. Guessing one is the paint
    // the key exists to prevent.
    const queryClient = new QueryClient();
    publishExternalAccountLimits(queryClient, ENVIRONMENT_ID, limitsFixture(60));
    expect(cachedFor(queryClient, SIGNED_IN)).toBeUndefined();

    const withoutTarget = clientWithAgents([]);
    publishExternalAccountLimits(withoutTarget, ENVIRONMENT_ID, limitsFixture(60));
    expect(cachedFor(withoutTarget, SIGNED_IN)).toBeUndefined();
  });

  it('does nothing for a chat with no environment', () => {
    const queryClient = clientWithAgents([SIGNED_IN]);
    publishExternalAccountLimits(queryClient, null, limitsFixture(60));
    expect(cachedFor(queryClient, SIGNED_IN)).toBeUndefined();
  });
});
