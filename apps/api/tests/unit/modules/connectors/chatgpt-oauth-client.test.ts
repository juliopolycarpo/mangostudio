import { describe, expect, it } from 'bun:test';
import {
  addConnector,
  ConnectorValidationError,
} from '../../../../src/modules/connectors/application/add-connector';
import {
  ChatGptOAuthError,
  ChatGptReauthRequiredError,
  decodeJwtPayload,
  exchangeAuthorizationCode,
  parseChatGptTokenBundle,
  refreshTokenGrant,
} from '../../../../src/modules/connectors/infrastructure/chatgpt/oauth-client';
import { CHATGPT_OAUTH_CLIENT_ID } from '../../../../src/modules/connectors/infrastructure/chatgpt/oauth-constants';
import {
  createOAuthState,
  createPkcePair,
} from '../../../../src/modules/connectors/infrastructure/oauth/pkce';
import {
  makeJwt,
  makeTokenBundle,
  makeTokenEndpointResponse,
  TEST_ACCOUNT_ID,
  TEST_EMAIL,
} from '../../../support/chatgpt';

const AUTH_BASE_URL = 'https://fake-auth.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createPkcePair', () => {
  it('produces an S256 challenge matching the verifier', async () => {
    const { verifier, challenge } = await createPkcePair();

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const expected = Buffer.from(new Uint8Array(digest)).toString('base64url');

    expect(challenge).toBe(expected);
    // RFC 7636: verifier must be 43-128 chars from the unreserved set.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(challenge).not.toContain('=');
  });

  it('produces unique verifiers and states per invocation', async () => {
    const [a, b] = await Promise.all([createPkcePair(), createPkcePair()]);
    expect(a.verifier).not.toBe(b.verifier);
    expect(createOAuthState()).not.toBe(createOAuthState());
  });
});

describe('decodeJwtPayload', () => {
  it('extracts the payload of a well-formed token', () => {
    const token = makeJwt({ sub: 'user-1', email: TEST_EMAIL });
    expect(decodeJwtPayload(token)).toMatchObject({ sub: 'user-1', email: TEST_EMAIL });
  });

  it('returns null for malformed tokens', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('a.!!!invalid-base64!!!.c')).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
  });
});

describe('exchangeAuthorizationCode', () => {
  it('sends the PKCE exchange and returns a bundle with identity claims', async () => {
    let capturedBody = '';
    const bundle = await exchangeAuthorizationCode({
      code: 'auth-code-1',
      codeVerifier: 'verifier-1',
      authBaseUrl: AUTH_BASE_URL,
      fetchImpl: (input, init) => {
        expect(String(input)).toBe(`${AUTH_BASE_URL}/oauth/token`);
        capturedBody = String(init?.body);
        return Promise.resolve(jsonResponse(makeTokenEndpointResponse()));
      },
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('auth-code-1');
    expect(params.get('code_verifier')).toBe('verifier-1');
    expect(params.get('client_id')).toBe(CHATGPT_OAUTH_CLIENT_ID);

    expect(bundle.accountId).toBe(TEST_ACCOUNT_ID);
    expect(bundle.planType).toBe('plus');
    expect(bundle.email).toBe(TEST_EMAIL);
    expect(bundle.refreshToken).toBe('refresh-token-rotated');
    expect(bundle.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects tokens without the ChatGPT account id claim', async () => {
    const exchange = exchangeAuthorizationCode({
      code: 'auth-code-1',
      codeVerifier: 'verifier-1',
      authBaseUrl: AUTH_BASE_URL,
      fetchImpl: async () =>
        jsonResponse(
          makeTokenEndpointResponse({
            access_token: makeJwt({ sub: 'no-auth-claim' }),
            id_token: makeJwt({ email: TEST_EMAIL }),
          })
        ),
    });

    await expect(exchange).rejects.toBeInstanceOf(ChatGptOAuthError);
  });

  it('surfaces a typed error when the token endpoint fails', async () => {
    const exchange = exchangeAuthorizationCode({
      code: 'auth-code-1',
      codeVerifier: 'verifier-1',
      authBaseUrl: AUTH_BASE_URL,
      fetchImpl: async () => new Response('server error', { status: 500 }),
    });

    await expect(exchange).rejects.toBeInstanceOf(ChatGptOAuthError);
  });
});

describe('refreshTokenGrant', () => {
  it('keeps the previous refresh token when the issuer does not rotate it', async () => {
    const previous = makeTokenBundle({ refreshToken: 'refresh-token-stable' });
    const rotated = await refreshTokenGrant({
      bundle: previous,
      authBaseUrl: AUTH_BASE_URL,
      fetchImpl: async () => jsonResponse(makeTokenEndpointResponse({ refresh_token: undefined })),
    });

    expect(rotated.refreshToken).toBe('refresh-token-stable');
  });

  it('maps invalid_grant to ChatGptReauthRequiredError', async () => {
    const refresh = refreshTokenGrant({
      bundle: makeTokenBundle(),
      authBaseUrl: AUTH_BASE_URL,
      fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 400),
    });

    await expect(refresh).rejects.toBeInstanceOf(ChatGptReauthRequiredError);
  });

  it('maps HTTP 401 to ChatGptReauthRequiredError', async () => {
    const refresh = refreshTokenGrant({
      bundle: makeTokenBundle(),
      authBaseUrl: AUTH_BASE_URL,
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    });

    await expect(refresh).rejects.toBeInstanceOf(ChatGptReauthRequiredError);
  });
});

describe('parseChatGptTokenBundle', () => {
  it('round-trips a serialized bundle', () => {
    const bundle = makeTokenBundle();
    expect(parseChatGptTokenBundle(JSON.stringify(bundle))).toEqual(bundle);
  });

  it('rejects non-JSON and malformed payloads', () => {
    expect(() => parseChatGptTokenBundle('not json')).toThrow(ChatGptOAuthError);
    expect(() => parseChatGptTokenBundle('{"version":2}')).toThrow(ChatGptOAuthError);
    expect(() => parseChatGptTokenBundle('{"version":1,"accessToken":42}')).toThrow(
      ChatGptOAuthError
    );
  });
});

describe('addConnector chatgpt source policy', () => {
  it.each(['config-file', 'environment'] as const)('rejects source %s', async (source) => {
    const add = addConnector('user-1', {
      name: 'my-chatgpt',
      apiKey: JSON.stringify(makeTokenBundle()),
      source,
      provider: 'chatgpt',
    });

    await expect(add).rejects.toBeInstanceOf(ConnectorValidationError);
  });
});
