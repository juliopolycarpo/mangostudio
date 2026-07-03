/**
 * ChatGPT OAuth token endpoint client.
 *
 * Exchanges authorization codes and refresh tokens against the issuer and
 * normalizes the response into the persisted token bundle. JWT payloads are
 * decoded without signature verification — the tokens come straight from the
 * issuer over TLS, so there is no untrusted hop to defend against.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import {
  CHATGPT_AUTH_CLAIM,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
} from './oauth-constants';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Persisted secret payload for a chatgpt connector (stored as JSON in the secret store). */
export interface ChatGptTokenBundle {
  version: 1;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** ChatGPT account id from the `https://api.openai.com/auth` claim. */
  accountId: string;
  /** Subscription plan type (plus, pro, ...) when the issuer reports one. */
  planType: string | null;
  email: string | null;
  /** Unix epoch ms when the access token expires. */
  expiresAt: number;
}

/** OAuth flow failure surfaced to the user (bad code, malformed response, ...). */
export class ChatGptOAuthError extends Error {
  readonly code = ERROR_CODES.VALIDATION;
  readonly status = 422;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChatGptOAuthError';
  }
}

/** The refresh token was revoked or expired — the user must sign in again. */
export const CHATGPT_REAUTH_REQUIRED_CODE = ERROR_CODES.CHATGPT_REAUTH_REQUIRED;

export class ChatGptReauthRequiredError extends Error {
  readonly code = CHATGPT_REAUTH_REQUIRED_CODE;
  readonly status = 401;

  constructor() {
    super('ChatGPT session expired. Sign in with ChatGPT again to reconnect.');
    this.name = 'ChatGptReauthRequiredError';
  }
}

/** Decodes a JWT payload segment without verifying the signature. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

function parseTokenEndpointPayload(payload: unknown): TokenEndpointResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ChatGptOAuthError('ChatGPT token endpoint returned a malformed response.');
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.access_token !== 'string' || !record.access_token) {
    throw new ChatGptOAuthError('ChatGPT token endpoint response is missing an access token.');
  }
  return {
    access_token: record.access_token,
    refresh_token: typeof record.refresh_token === 'string' ? record.refresh_token : undefined,
    id_token: typeof record.id_token === 'string' ? record.id_token : undefined,
    expires_in: typeof record.expires_in === 'number' ? record.expires_in : undefined,
  };
}

/** Extracts account id, plan type, and email from access/id token claims. */
function extractIdentity(
  accessToken: string,
  idToken: string
): { accountId: string; planType: string | null; email: string | null } {
  const accessClaims = decodeJwtPayload(accessToken);
  const idClaims = decodeJwtPayload(idToken);

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

  const planType =
    typeof authClaim?.chatgpt_plan_type === 'string' ? authClaim.chatgpt_plan_type : null;
  const email = typeof idClaims?.email === 'string' ? idClaims.email : null;
  return { accountId, planType, email };
}

const DEFAULT_ACCESS_TOKEN_TTL_MS = 3_600_000;

function toTokenBundle(tokens: TokenEndpointResponse, previous?: ChatGptTokenBundle) {
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) {
    throw new ChatGptOAuthError('ChatGPT token endpoint response is missing a refresh token.');
  }
  const idToken = tokens.id_token ?? previous?.idToken ?? '';
  const identity = extractIdentity(tokens.access_token, idToken);

  const bundle: ChatGptTokenBundle = {
    version: 1,
    accessToken: tokens.access_token,
    refreshToken,
    idToken,
    ...identity,
    expiresAt:
      Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : DEFAULT_ACCESS_TOKEN_TTL_MS),
  };
  return bundle;
}

async function requestToken(
  authBaseUrl: string,
  params: Record<string, string>,
  fetchImpl: FetchLike
): Promise<TokenEndpointResponse> {
  let response: Response;
  try {
    response = await fetchImpl(`${authBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CHATGPT_OAUTH_CLIENT_ID, ...params }).toString(),
    });
  } catch (error) {
    throw new ChatGptOAuthError('Could not reach the ChatGPT authorization server.', {
      cause: error,
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 401 || body.includes('invalid_grant')) {
      throw new ChatGptReauthRequiredError();
    }
    throw new ChatGptOAuthError(
      `ChatGPT token endpoint rejected the request (HTTP ${response.status}).`
    );
  }

  return parseTokenEndpointPayload(await response.json().catch(() => null));
}

/** Exchanges an authorization code (plus PKCE verifier) for a token bundle. */
export async function exchangeAuthorizationCode(options: {
  code: string;
  codeVerifier: string;
  authBaseUrl: string;
  fetchImpl?: FetchLike;
}): Promise<ChatGptTokenBundle> {
  const tokens = await requestToken(
    options.authBaseUrl,
    {
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: CHATGPT_OAUTH_REDIRECT_URI,
      code_verifier: options.codeVerifier,
    },
    options.fetchImpl ?? fetch
  );
  return toTokenBundle(tokens);
}

/** Refreshes an existing bundle; the rotated refresh token replaces the old one. */
export async function refreshTokenGrant(options: {
  bundle: ChatGptTokenBundle;
  authBaseUrl: string;
  fetchImpl?: FetchLike;
}): Promise<ChatGptTokenBundle> {
  const tokens = await requestToken(
    options.authBaseUrl,
    {
      grant_type: 'refresh_token',
      refresh_token: options.bundle.refreshToken,
    },
    options.fetchImpl ?? fetch
  );
  return toTokenBundle(tokens, options.bundle);
}

/** Parses and validates a persisted token bundle JSON string. */
export function parseChatGptTokenBundle(raw: string): ChatGptTokenBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatGptOAuthError('Stored ChatGPT token bundle is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ChatGptOAuthError('Stored ChatGPT token bundle is malformed.');
  }
  const bundle = parsed as Record<string, unknown>;
  if (
    bundle.version !== 1 ||
    typeof bundle.accessToken !== 'string' ||
    typeof bundle.refreshToken !== 'string' ||
    typeof bundle.accountId !== 'string' ||
    typeof bundle.expiresAt !== 'number'
  ) {
    throw new ChatGptOAuthError('Stored ChatGPT token bundle is malformed.');
  }
  return {
    version: 1,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    idToken: typeof bundle.idToken === 'string' ? bundle.idToken : '',
    accountId: bundle.accountId,
    planType: typeof bundle.planType === 'string' ? bundle.planType : null,
    email: typeof bundle.email === 'string' ? bundle.email : null,
    expiresAt: bundle.expiresAt,
  };
}
