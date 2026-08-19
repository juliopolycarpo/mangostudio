/**
 * ChatGPT OAuth provider profile and typed bindings for the shared OAuth core.
 *
 * All flow mechanics (token endpoint exchange, bundle codec, JWT decoding)
 * live in ../oauth/token-client; this file contributes only what is
 * ChatGPT-specific: the registered client constants, the identity claims,
 * and the error types the HTTP layer branches on.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import {
  exchangeAuthorizationCode as coreExchangeAuthorizationCode,
  parseTokenBundle as coreParseTokenBundle,
  refreshTokenGrant as coreRefreshTokenGrant,
  type FetchLike,
  OAuthFlowError,
  type OAuthProviderProfile,
  OAuthReauthRequiredError,
  type OAuthTokenBundle,
} from '../oauth/token-client';
import {
  CHATGPT_AUTH_CLAIM,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CHATGPT_OAUTH_SCOPES,
} from './oauth-constants';

export { decodeJwtPayload } from '../oauth/token-client';

export interface ChatGptIdentity {
  /** ChatGPT account id from the `https://api.openai.com/auth` claim. */
  accountId: string;
  /** Subscription plan type (plus, pro, ...) when the issuer reports one. */
  planType: string | null;
  email: string | null;
}

/** Persisted secret payload for a chatgpt connector (stored as JSON in the secret store). */
export type ChatGptTokenBundle = OAuthTokenBundle<ChatGptIdentity>;

/** OAuth flow failure surfaced to the user (bad code, malformed response, ...). */
export class ChatGptOAuthError extends OAuthFlowError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChatGptOAuthError';
  }
}

/** The refresh token was revoked or expired — the user must sign in again. */
export const CHATGPT_REAUTH_REQUIRED_CODE = ERROR_CODES.CHATGPT_REAUTH_REQUIRED;

export class ChatGptReauthRequiredError extends OAuthReauthRequiredError {
  readonly code = CHATGPT_REAUTH_REQUIRED_CODE;

  constructor() {
    super('ChatGPT session expired. Sign in with ChatGPT again to reconnect.');
    this.name = 'ChatGptReauthRequiredError';
  }
}

export const chatGptOAuthProfile: OAuthProviderProfile<ChatGptIdentity> = {
  label: 'ChatGPT',
  clientId: CHATGPT_OAUTH_CLIENT_ID,
  redirectUri: CHATGPT_OAUTH_REDIRECT_URI,
  scopes: CHATGPT_OAUTH_SCOPES,

  extractIdentity(accessClaims, idClaims) {
    const authClaim = (accessClaims?.[CHATGPT_AUTH_CLAIM] ?? idClaims?.[CHATGPT_AUTH_CLAIM]) as
      | Record<string, unknown>
      | undefined;
    const accountId =
      typeof authClaim?.chatgpt_account_id === 'string' ? authClaim.chatgpt_account_id : '';
    if (!accountId) {
      throw new ChatGptOAuthError(
        'ChatGPT tokens are missing the account id claim. This account may not have an active ChatGPT plan.'
      );
    }

    return {
      accountId,
      planType:
        typeof authClaim?.chatgpt_plan_type === 'string' ? authClaim.chatgpt_plan_type : null,
      email: typeof idClaims?.email === 'string' ? idClaims.email : null,
    };
  },

  parseIdentity(record) {
    if (typeof record.accountId !== 'string') return null;
    return {
      accountId: record.accountId,
      planType: typeof record.planType === 'string' ? record.planType : null,
      email: typeof record.email === 'string' ? record.email : null,
    };
  },

  createFlowError: (message, options) => new ChatGptOAuthError(message, options),
  createReauthError: () => new ChatGptReauthRequiredError(),
};

/** Exchanges an authorization code (plus PKCE verifier) for a token bundle. */
export function exchangeAuthorizationCode(options: {
  code: string;
  codeVerifier: string;
  authBaseUrl: string;
  /** Must repeat the redirect URI the authorize request carried. */
  redirectUri?: string;
  fetchImpl?: FetchLike;
}): Promise<ChatGptTokenBundle> {
  return coreExchangeAuthorizationCode(chatGptOAuthProfile, options);
}

/** Refreshes an existing bundle; the rotated refresh token replaces the old one. */
export function refreshTokenGrant(options: {
  bundle: ChatGptTokenBundle;
  authBaseUrl: string;
  fetchImpl?: FetchLike;
}): Promise<ChatGptTokenBundle> {
  return coreRefreshTokenGrant(chatGptOAuthProfile, options);
}

/** Parses and validates a persisted token bundle JSON string. */
export function parseChatGptTokenBundle(raw: string): ChatGptTokenBundle {
  return coreParseTokenBundle(chatGptOAuthProfile, raw);
}
