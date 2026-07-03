/**
 * Fixture helpers for ChatGPT OAuth tests — unsigned JWTs carrying the claim
 * shapes the real issuer returns, and canned token bundles.
 */

import type { ChatGptTokenBundle } from '../../../src/modules/connectors/infrastructure/chatgpt/oauth-client';

function base64Url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Builds a structurally valid JWT with an arbitrary payload (unverified signature). */
export function makeJwt(payload: Record<string, unknown>): string {
  return `${base64Url({ alg: 'RS256', typ: 'JWT' })}.${base64Url(payload)}.fake-signature`;
}

export const TEST_ACCOUNT_ID = 'acct-1234567890';
export const TEST_EMAIL = 'user@example.com';

export function makeAccessToken(
  overrides: Record<string, unknown> = {},
  accountId = TEST_ACCOUNT_ID
): string {
  return makeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: 'plus',
    },
    ...overrides,
  });
}

export function makeIdToken(email = TEST_EMAIL): string {
  return makeJwt({ email });
}

export function makeTokenBundle(overrides: Partial<ChatGptTokenBundle> = {}): ChatGptTokenBundle {
  return {
    version: 1,
    accessToken: makeAccessToken(),
    refreshToken: 'refresh-token-1',
    idToken: makeIdToken(),
    accountId: TEST_ACCOUNT_ID,
    planType: 'plus',
    email: TEST_EMAIL,
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

/** Canned token-endpoint JSON body for a successful exchange or refresh. */
export function makeTokenEndpointResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    access_token: makeAccessToken(),
    refresh_token: 'refresh-token-rotated',
    id_token: makeIdToken(),
    expires_in: 3600,
    ...overrides,
  };
}
