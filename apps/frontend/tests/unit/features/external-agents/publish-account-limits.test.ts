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
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { QueryClient } from '@tanstack/react-query';
import {
  externalAccountLimitsKey,
  publishExternalAccountLimits,
} from '@/features/external-agents/queries';

const ENVIRONMENT_ID = 'local';
const OBSERVED_AT = 1_787_000_000_000;

function descriptorFor(fingerprint: string | null): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId: ENVIRONMENT_ID,
    installed: true,
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    ...(fingerprint ? { account: { fingerprint } } : {}),
  } as unknown as ExternalAgentDescriptor;
}

const SIGNED_IN = descriptorFor('account-a');
const OTHER_ACCOUNT = descriptorFor('account-b');
const NO_ACCOUNT = descriptorFor(null);

function limitsFixture(usedPercent: number, observedAtMs = OBSERVED_AT): ExternalAccountLimits {
  return { targetId: 'codex', windows: [{ usedPercent }], observedAtMs };
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
    const queryClient = new QueryClient();
    publishExternalAccountLimits(queryClient, ENVIRONMENT_ID, limitsFixture(60), 'account-a');
    expect(cachedFor(queryClient, SIGNED_IN)).toEqual(limitsFixture(60));
  });

  it('replaces a cold read that answered "no snapshot"', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(externalAccountLimitsKey(SIGNED_IN), null);
    publishExternalAccountLimits(queryClient, ENVIRONMENT_ID, limitsFixture(60), 'account-a');
    expect(cachedFor(queryClient, SIGNED_IN)).toEqual(limitsFixture(60));
  });

  it('leaves a newer snapshot alone', () => {
    const queryClient = new QueryClient();
    const newer = limitsFixture(10, OBSERVED_AT + 60_000);
    queryClient.setQueryData(externalAccountLimitsKey(SIGNED_IN), newer);
    // A manual refresh that landed while the turn was still streaming: the
    // stream's reading is older, and older never wins.
    publishExternalAccountLimits(queryClient, ENVIRONMENT_ID, limitsFixture(60), 'account-a');
    expect(cachedFor(queryClient, SIGNED_IN)).toEqual(newer);
  });

  it('writes under the account the turn is bound to, not the one on screen', () => {
    const queryClient = new QueryClient();
    const stale = limitsFixture(99, OBSERVED_AT - 60_000);
    queryClient.setQueryData(externalAccountLimitsKey(OTHER_ACCOUNT), stale);

    // The user signed into account B mid-turn, so discovery now describes B —
    // but the running turn, and the reading it just reported, are still A's.
    publishExternalAccountLimits(queryClient, ENVIRONMENT_ID, limitsFixture(60), 'account-a');

    expect(cachedFor(queryClient, OTHER_ACCOUNT)).toEqual(stale);
    expect(cachedFor(queryClient, SIGNED_IN)).toEqual(limitsFixture(60));
  });

  it('files a vendor with no account under the same identity the reads use', () => {
    const queryClient = new QueryClient();
    publishExternalAccountLimits(queryClient, ENVIRONMENT_ID, limitsFixture(60), null);
    expect(cachedFor(queryClient, NO_ACCOUNT)).toEqual(limitsFixture(60));
    // "No account" is an identity of its own, not a wildcard that matches one.
    expect(cachedFor(queryClient, SIGNED_IN)).toBeUndefined();
  });

  it('does nothing for a chat with no environment', () => {
    const queryClient = new QueryClient();
    publishExternalAccountLimits(queryClient, null, limitsFixture(60), 'account-a');
    expect(cachedFor(queryClient, SIGNED_IN)).toBeUndefined();
  });
});
