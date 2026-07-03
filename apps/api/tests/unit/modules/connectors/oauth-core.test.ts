/**
 * Proves the OAuth connector core is provider-agnostic: a second fake profile
 * with different claims, identity shape, port, and callback path drives the
 * whole stack — token client, token service, loopback server, session store —
 * without touching any core code.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import {
  type LoopbackServerOptions,
  type OAuthLoopbackServer,
  startOAuthLoopbackServer,
} from '../../../../src/modules/connectors/infrastructure/oauth/loopback-server';
import {
  createOAuthSessionStore,
  type OAuthSessionBase,
} from '../../../../src/modules/connectors/infrastructure/oauth/session-store';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  OAuthFlowError,
  type OAuthProviderProfile,
  OAuthReauthRequiredError,
  parseTokenBundle,
  refreshTokenGrant,
} from '../../../../src/modules/connectors/infrastructure/oauth/token-client';
import { createOAuthTokenService } from '../../../../src/modules/connectors/infrastructure/oauth/token-service';
import type { SecretMetadataInput } from '../../../../src/services/secret-store/metadata';
import { makeJwt } from '../../../support/chatgpt';
import { createMockSecretStore } from '../../../support/mocks/mock-secret-store';

const AUTH_BASE_URL = 'https://fake-acme-auth.test';
const ACME_CLAIM = 'https://acme.test/auth';

interface AcmeIdentity {
  workspaceId: string;
  tier: string | null;
}

class AcmeOAuthError extends OAuthFlowError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AcmeOAuthError';
  }
}

class AcmeReauthRequiredError extends OAuthReauthRequiredError {
  readonly code = 'ACME_REAUTH_REQUIRED';

  constructor() {
    super('Acme session expired.');
    this.name = 'AcmeReauthRequiredError';
  }
}

const acmeProfile: OAuthProviderProfile<AcmeIdentity> = {
  label: 'Acme',
  clientId: 'acme-client-id',
  redirectUri: 'http://localhost:14559/acme/done',
  scopes: 'openid acme.workspaces',
  extractIdentity(accessClaims) {
    const claim = accessClaims?.[ACME_CLAIM] as Record<string, unknown> | undefined;
    const workspaceId = typeof claim?.workspace_id === 'string' ? claim.workspace_id : '';
    if (!workspaceId) throw new AcmeOAuthError('Acme tokens are missing the workspace claim.');
    return {
      workspaceId,
      tier: typeof claim?.tier === 'string' ? claim.tier : null,
    };
  },
  parseIdentity(record) {
    if (typeof record.workspaceId !== 'string') return null;
    return {
      workspaceId: record.workspaceId,
      tier: typeof record.tier === 'string' ? record.tier : null,
    };
  },
  createFlowError: (message, options) => new AcmeOAuthError(message, options),
  createReauthError: () => new AcmeReauthRequiredError(),
};

function makeAcmeAccessToken(workspaceId = 'ws-42'): string {
  return makeJwt({ [ACME_CLAIM]: { workspace_id: workspaceId, tier: 'gold' } });
}

function makeAcmeTokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: makeAcmeAccessToken(),
    refresh_token: 'acme-refresh-rotated',
    id_token: makeJwt({ email: 'acme@example.com' }),
    expires_in: 3600,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('oauth core with a second provider profile', () => {
  it('builds the authorize URL from the profile', () => {
    const url = new URL(buildAuthorizeUrl(acmeProfile, AUTH_BASE_URL, 'state-1', 'challenge-1'));

    expect(url.origin).toBe(AUTH_BASE_URL);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('acme-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:14559/acme/done');
    expect(url.searchParams.get('scope')).toBe('openid acme.workspaces');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('exchanges a code using the profile client id, redirect, and claims', async () => {
    let capturedBody = '';
    const bundle = await exchangeAuthorizationCode(acmeProfile, {
      code: 'code-1',
      codeVerifier: 'verifier-1',
      authBaseUrl: AUTH_BASE_URL,
      fetchImpl: (input, init) => {
        expect(String(input)).toBe(`${AUTH_BASE_URL}/oauth/token`);
        capturedBody = String(init?.body);
        return Promise.resolve(jsonResponse(makeAcmeTokenResponse()));
      },
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get('client_id')).toBe('acme-client-id');
    expect(params.get('redirect_uri')).toBe('http://localhost:14559/acme/done');

    expect(bundle.workspaceId).toBe('ws-42');
    expect(bundle.tier).toBe('gold');
    expect(bundle.refreshToken).toBe('acme-refresh-rotated');
  });

  it('throws the profile flow error when its identity claims are missing', async () => {
    const exchange = exchangeAuthorizationCode(acmeProfile, {
      code: 'code-1',
      codeVerifier: 'verifier-1',
      authBaseUrl: AUTH_BASE_URL,
      fetchImpl: async () =>
        jsonResponse(makeAcmeTokenResponse({ access_token: makeJwt({ sub: 'no-claim' }) })),
    });

    await expect(exchange).rejects.toBeInstanceOf(AcmeOAuthError);
  });

  it('maps refresh rejections to the profile reauth error', async () => {
    const bundle = parseTokenBundle(
      acmeProfile,
      JSON.stringify({
        version: 1,
        accessToken: makeAcmeAccessToken(),
        refreshToken: 'acme-refresh-1',
        idToken: '',
        expiresAt: Date.now() - 1,
        workspaceId: 'ws-42',
        tier: 'gold',
      })
    );

    const refresh = refreshTokenGrant(acmeProfile, {
      bundle,
      authBaseUrl: AUTH_BASE_URL,
      fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 400),
    });

    await expect(refresh).rejects.toBeInstanceOf(AcmeReauthRequiredError);
    await expect(refresh).rejects.toBeInstanceOf(OAuthReauthRequiredError);
  });

  it('round-trips a bundle and rejects one missing the profile identity', () => {
    const raw = JSON.stringify({
      version: 1,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      idToken: 'id-1',
      expiresAt: 123,
      workspaceId: 'ws-42',
      tier: null,
    });

    expect(parseTokenBundle(acmeProfile, raw)).toEqual(JSON.parse(raw));
    expect(() => parseTokenBundle(acmeProfile, '{"version":1,"accessToken":"a"}')).toThrow(
      AcmeOAuthError
    );
    expect(() =>
      parseTokenBundle(
        acmeProfile,
        JSON.stringify({
          version: 1,
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: 1,
          workspaceId: 42,
        })
      )
    ).toThrow(AcmeOAuthError);
  });
});

describe('oauth token service with a second provider profile', () => {
  const NOW = Date.now();

  function makeConnectorRow(): SecretMetadataRow {
    return {
      id: 'acme-connector-1',
      name: 'acme-test',
      provider: 'acme' as SecretMetadataRow['provider'],
      configured: 1,
      source: 'bun-secrets',
      maskedSuffix: null,
      updatedAt: NOW,
      lastValidatedAt: null,
      lastValidationError: null,
      enabledModels: '[]',
      userId: 'user-1',
      baseUrl: null,
    };
  }

  function makeService(options: { expiresAt: number; tokenEndpoint?: () => Response }) {
    const row = makeConnectorRow();
    const secretName = (id: string) => `acme-tokens:${id}`;
    const secretStore = createMockSecretStore([
      {
        secret: { service: 'mangostudio', name: secretName(row.id) },
        value: JSON.stringify({
          version: 1,
          accessToken: makeAcmeAccessToken(),
          refreshToken: 'acme-refresh-1',
          idToken: '',
          expiresAt: options.expiresAt,
          workspaceId: 'ws-42',
          tier: 'gold',
        }),
      },
    ]);
    const upserts: SecretMetadataInput[] = [];

    const service = createOAuthTokenService(
      { profile: acmeProfile, secretName, resolveAuthBaseUrl: () => AUTH_BASE_URL },
      {
        secretStore,
        now: () => NOW,
        fetchImpl: async () => options.tokenEndpoint?.() ?? jsonResponse(makeAcmeTokenResponse()),
        upsertMetadata: (input) => {
          upserts.push(input);
          return Promise.resolve();
        },
      }
    );

    return { row, service, secretStore, secretName, upserts };
  }

  it('refreshes near expiry and persists the rotation under the profile secret name', async () => {
    const harness = makeService({ expiresAt: NOW + 30_000 });

    const bundle = await harness.service.ensureFreshTokens(harness.row);

    expect(bundle.refreshToken).toBe('acme-refresh-rotated');
    expect(bundle.workspaceId).toBe('ws-42');

    const stored = harness.secretStore.store.get(
      `mangostudio:${harness.secretName(harness.row.id)}`
    );
    expect(JSON.parse(stored as string).refreshToken).toBe('acme-refresh-rotated');
  });

  it('marks the connector row with the profile reauth code on invalid_grant', async () => {
    const harness = makeService({
      expiresAt: NOW - 1_000,
      tokenEndpoint: () => jsonResponse({ error: 'invalid_grant' }, 400),
    });

    await expect(harness.service.ensureFreshTokens(harness.row)).rejects.toBeInstanceOf(
      AcmeReauthRequiredError
    );
    expect(harness.upserts[0]).toMatchObject({
      id: harness.row.id,
      lastValidationError: 'ACME_REAUTH_REQUIRED',
    });
  });
});

describe('oauth loopback server with a second provider profile', () => {
  const PORT = 14559;
  const CALLBACK_PATH = '/acme/done';

  let activeServer: OAuthLoopbackServer | null = null;

  function startServer(overrides: Partial<LoopbackServerOptions> = {}) {
    const codes: string[] = [];
    const failures: string[] = [];
    const server = startOAuthLoopbackServer({
      providerLabel: 'Acme',
      port: PORT,
      callbackPath: CALLBACK_PATH,
      expectedState: 'expected-state',
      ttlMs: 30_000,
      createPortBusyError: () => new Error('acme port busy'),
      onAuthorizationCode: (code) => {
        codes.push(code);
        return Promise.resolve();
      },
      onFailure: (message) => {
        failures.push(message);
      },
      ...overrides,
    });
    activeServer = server;
    return { server, codes, failures };
  }

  afterEach(() => {
    activeServer?.stop();
    activeServer = null;
  });

  it('serves the profile callback path and injects the provider label', async () => {
    const { codes } = startServer();

    const response = await fetch(
      `http://127.0.0.1:${PORT}${CALLBACK_PATH}?code=code-1&state=expected-state`
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Signed in with Acme');
    expect(codes).toEqual(['code-1']);
  });

  it('labels failure messages with the provider', async () => {
    const { failures } = startServer();

    await fetch(`http://127.0.0.1:${PORT}${CALLBACK_PATH}?error=access_denied`);

    expect(failures[0]).toBe('Acme sign-in was not completed: access_denied');
  });

  it('throws the injected port-busy error when the port is bound', () => {
    startServer();

    expect(() => startServer()).toThrow('acme port busy');
  });
});

describe('oauth session store', () => {
  interface TestSession extends OAuthSessionBase {
    connectorName: string;
  }

  function makeSession(overrides: Partial<TestSession> = {}): {
    session: TestSession;
    stops: number[];
  } {
    const stops: number[] = [];
    const session: TestSession = {
      id: crypto.randomUUID(),
      userId: 'user-1',
      connectorName: 'acme',
      status: 'pending',
      expiresAt: 1_000,
      loopback: { stop: () => stops.push(1) },
      ...overrides,
    };
    return { session, stops };
  }

  it('scopes lookups to the owning user', () => {
    const store = createOAuthSessionStore<TestSession>();
    const { session } = makeSession();
    store.add(session);

    expect(store.get('user-1', session.id)).toBe(session);
    expect(store.get('user-2', session.id)).toBeUndefined();
    expect(store.get('user-1', 'missing')).toBeUndefined();
  });

  it('cancels only the pending sessions of the requested user', () => {
    const store = createOAuthSessionStore<TestSession>();
    const pending = makeSession();
    const completed = makeSession({ status: 'completed' });
    const otherUser = makeSession({ userId: 'user-2' });
    store.add(pending.session);
    store.add(completed.session);
    store.add(otherUser.session);

    store.cancelPendingForUser('user-1');

    expect(store.get('user-1', pending.session.id)).toBeUndefined();
    expect(pending.stops).toHaveLength(1);
    expect(store.get('user-1', completed.session.id)).toBe(completed.session);
    expect(store.get('user-2', otherUser.session.id)).toBe(otherUser.session);
    expect(otherUser.stops).toHaveLength(0);
  });

  it('only fails a session once and keeps the first failure', () => {
    const store = createOAuthSessionStore<TestSession>();
    const { session } = makeSession();
    store.add(session);

    expect(store.markFailed(session, 'first failure', 'CODE_1')).toBe(true);
    expect(store.markFailed(session, 'second failure')).toBe(false);
    expect(session.status).toBe('failed');
    expect(session.error).toBe('first failure');
    expect(session.errorCode).toBe('CODE_1');
  });

  it('expires pending sessions past their TTL and frees the loopback port', () => {
    const store = createOAuthSessionStore<TestSession>();
    const { session, stops } = makeSession({ expiresAt: 1_000 });
    store.add(session);

    store.expireIfDue(session, 999);
    expect(session.status).toBe('pending');

    store.expireIfDue(session, 1_001);
    expect(session.status).toBe('expired');
    expect(stops).toHaveLength(1);

    // A settled session never transitions again.
    store.markFailed(session, 'late failure');
    expect(session.status).toBe('expired');
  });
});
