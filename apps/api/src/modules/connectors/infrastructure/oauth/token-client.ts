/**
 * Provider-agnostic OAuth token endpoint client and token bundle codec.
 *
 * Everything provider-specific — client id, redirect URI, identity claims,
 * error types — comes in through an `OAuthProviderProfile`; adding a second
 * OAuth provider means writing a profile, not another client. JWT payloads are
 * decoded without signature verification — the tokens come straight from the
 * issuer over TLS, so there is no untrusted hop to defend against.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** OAuth flow failure surfaced to the user (bad code, malformed response, ...). */
export class OAuthFlowError extends Error {
  readonly code: string = ERROR_CODES.VALIDATION;
  readonly status: number = 422;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OAuthFlowError';
  }
}

/**
 * The refresh token was revoked or expired — the user must sign in again.
 * Providers subclass this with their own error code so callers can both
 * branch on the provider type and handle any OAuth reauth generically.
 */
export abstract class OAuthReauthRequiredError extends Error {
  abstract readonly code: string;
  readonly status = 401;
}

/** Provider-independent fields of a persisted token bundle. */
interface OAuthTokenBundleBase {
  version: 1;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Unix epoch ms when the access token expires. */
  expiresAt: number;
}

/** Persisted secret payload: the base fields plus the provider's identity. */
export type OAuthTokenBundle<TIdentity extends object> = OAuthTokenBundleBase & TIdentity;

/** Everything the OAuth core needs to know about one provider. */
export interface OAuthProviderProfile<TIdentity extends object> {
  /** Human-readable provider label used in error messages, e.g. "ChatGPT". */
  label: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  /**
   * Extracts the provider identity from the decoded access/id token claims.
   * Must throw the provider's flow error when required claims are missing.
   */
  extractIdentity(
    accessClaims: Record<string, unknown> | null,
    idClaims: Record<string, unknown> | null
  ): TIdentity;
  /** Parses the identity fields of a persisted bundle; null means malformed. */
  parseIdentity(record: Record<string, unknown>): TIdentity | null;
  createFlowError(message: string, options?: ErrorOptions): OAuthFlowError;
  createReauthError(): OAuthReauthRequiredError;
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

/** Builds the issuer authorize URL for a PKCE authorization-code flow. */
export function buildAuthorizeUrl(
  profile: OAuthProviderProfile<object>,
  options: {
    authBaseUrl: string;
    state: string;
    challenge: string;
    /**
     * Overrides the profile's registered redirect URI. The token exchange must
     * repeat whichever one is sent here.
     */
    redirectUri?: string;
  }
): string {
  const url = new URL('/oauth/authorize', options.authBaseUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: profile.clientId,
    redirect_uri: options.redirectUri ?? profile.redirectUri,
    scope: profile.scopes,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    state: options.state,
  }).toString();
  return url.toString();
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

function parseTokenEndpointPayload(
  profile: OAuthProviderProfile<object>,
  payload: unknown
): TokenEndpointResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw profile.createFlowError(`${profile.label} token endpoint returned a malformed response.`);
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.access_token !== 'string' || !record.access_token) {
    throw profile.createFlowError(
      `${profile.label} token endpoint response is missing an access token.`
    );
  }
  return {
    access_token: record.access_token,
    refresh_token: typeof record.refresh_token === 'string' ? record.refresh_token : undefined,
    id_token: typeof record.id_token === 'string' ? record.id_token : undefined,
    expires_in: typeof record.expires_in === 'number' ? record.expires_in : undefined,
  };
}

const DEFAULT_ACCESS_TOKEN_TTL_MS = 3_600_000;

function toTokenBundle<TIdentity extends object>(
  profile: OAuthProviderProfile<TIdentity>,
  tokens: TokenEndpointResponse,
  previous?: OAuthTokenBundle<TIdentity>
): OAuthTokenBundle<TIdentity> {
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) {
    throw profile.createFlowError(
      `${profile.label} token endpoint response is missing a refresh token.`
    );
  }
  const idToken = tokens.id_token ?? previous?.idToken ?? '';
  const identity = profile.extractIdentity(
    decodeJwtPayload(tokens.access_token),
    decodeJwtPayload(idToken)
  );

  return {
    version: 1,
    accessToken: tokens.access_token,
    refreshToken,
    idToken,
    expiresAt:
      Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : DEFAULT_ACCESS_TOKEN_TTL_MS),
    ...identity,
  };
}

async function requestToken(
  profile: OAuthProviderProfile<object>,
  authBaseUrl: string,
  params: Record<string, string>,
  fetchImpl: FetchLike
): Promise<TokenEndpointResponse> {
  let response: Response;
  try {
    response = await fetchImpl(`${authBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: profile.clientId, ...params }).toString(),
    });
  } catch (error) {
    throw profile.createFlowError(`Could not reach the ${profile.label} authorization server.`, {
      cause: error,
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 401 || body.includes('invalid_grant')) {
      throw profile.createReauthError();
    }
    throw profile.createFlowError(
      `${profile.label} token endpoint rejected the request (HTTP ${response.status}).`
    );
  }

  return parseTokenEndpointPayload(profile, await response.json().catch(() => null));
}

/** Exchanges an authorization code (plus PKCE verifier) for a token bundle. */
export async function exchangeAuthorizationCode<TIdentity extends object>(
  profile: OAuthProviderProfile<TIdentity>,
  options: {
    code: string;
    codeVerifier: string;
    authBaseUrl: string;
    /** Must repeat the redirect URI the authorize request carried. */
    redirectUri?: string;
    fetchImpl?: FetchLike;
  }
): Promise<OAuthTokenBundle<TIdentity>> {
  const tokens = await requestToken(
    profile,
    options.authBaseUrl,
    {
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri ?? profile.redirectUri,
      code_verifier: options.codeVerifier,
    },
    options.fetchImpl ?? fetch
  );
  return toTokenBundle(profile, tokens);
}

/** Refreshes an existing bundle; the rotated refresh token replaces the old one. */
export async function refreshTokenGrant<TIdentity extends object>(
  profile: OAuthProviderProfile<TIdentity>,
  options: {
    bundle: OAuthTokenBundle<TIdentity>;
    authBaseUrl: string;
    fetchImpl?: FetchLike;
  }
): Promise<OAuthTokenBundle<TIdentity>> {
  const tokens = await requestToken(
    profile,
    options.authBaseUrl,
    {
      grant_type: 'refresh_token',
      refresh_token: options.bundle.refreshToken,
    },
    options.fetchImpl ?? fetch
  );
  return toTokenBundle(profile, tokens, options.bundle);
}

/** Parses and validates a persisted token bundle JSON string. */
export function parseTokenBundle<TIdentity extends object>(
  profile: OAuthProviderProfile<TIdentity>,
  raw: string
): OAuthTokenBundle<TIdentity> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw profile.createFlowError(`Stored ${profile.label} token bundle is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw profile.createFlowError(`Stored ${profile.label} token bundle is malformed.`);
  }
  const record = parsed as Record<string, unknown>;
  const identity =
    record.version === 1 &&
    typeof record.accessToken === 'string' &&
    typeof record.refreshToken === 'string' &&
    typeof record.expiresAt === 'number'
      ? profile.parseIdentity(record)
      : null;
  if (!identity) {
    throw profile.createFlowError(`Stored ${profile.label} token bundle is malformed.`);
  }
  return {
    version: 1,
    accessToken: record.accessToken as string,
    refreshToken: record.refreshToken as string,
    idToken: typeof record.idToken === 'string' ? record.idToken : '',
    expiresAt: record.expiresAt as number,
    ...identity,
  };
}
