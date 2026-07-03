import { describe, expect, it } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import {
  ChatGptOAuthError,
  ChatGptReauthRequiredError,
} from '../../../../src/modules/connectors/infrastructure/chatgpt/oauth-client';
import {
  chatGptSecretName,
  createChatGptTokenService,
} from '../../../../src/modules/connectors/infrastructure/chatgpt/token-service';
import type { SecretMetadataInput } from '../../../../src/services/secret-store/metadata';
import { makeTokenBundle, makeTokenEndpointResponse } from '../../../support/chatgpt';
import { createMockSecretStore } from '../../../support/mocks/mock-secret-store';

const AUTH_BASE_URL = 'https://fake-auth.test';
// Anchored to the real clock: the oauth client computes rotated-bundle expiry
// from Date.now(), so a fully synthetic epoch would mix two clocks.
const NOW = Date.now();

function makeConnectorRow(id = 'connector-1'): SecretMetadataRow {
  return {
    id,
    name: 'chatgpt-test',
    provider: 'chatgpt',
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

function makeHarness(options: {
  bundleExpiresAt: number;
  tokenEndpoint?: (callCount: number) => Response;
}) {
  const row = makeConnectorRow();
  const secretStore = createMockSecretStore([
    {
      secret: { service: 'mangostudio', name: chatGptSecretName(row.id) },
      value: JSON.stringify(makeTokenBundle({ expiresAt: options.bundleExpiresAt })),
    },
  ]);

  let refreshCalls = 0;
  const upserts: SecretMetadataInput[] = [];

  const service = createChatGptTokenService({
    secretStore,
    now: () => NOW,
    authBaseUrl: AUTH_BASE_URL,
    fetchImpl: () => {
      refreshCalls += 1;
      return Promise.resolve(
        options.tokenEndpoint?.(refreshCalls) ??
          new Response(JSON.stringify(makeTokenEndpointResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      );
    },
    upsertMetadata: (input) => {
      upserts.push(input);
      return Promise.resolve();
    },
  });

  return {
    row,
    secretStore,
    service,
    upserts,
    refreshCalls: () => refreshCalls,
  };
}

describe('chatgpt token service', () => {
  it('returns the stored bundle untouched while outside the expiry skew window', async () => {
    const harness = makeHarness({ bundleExpiresAt: NOW + 120_000 });

    const bundle = await harness.service.ensureFreshTokens(harness.row);

    expect(bundle.refreshToken).toBe('refresh-token-1');
    expect(harness.refreshCalls()).toBe(0);
    expect(harness.upserts).toHaveLength(0);
  });

  it('refreshes inside the skew window and persists the rotated bundle', async () => {
    const harness = makeHarness({ bundleExpiresAt: NOW + 30_000 });

    const bundle = await harness.service.ensureFreshTokens(harness.row);

    expect(harness.refreshCalls()).toBe(1);
    expect(bundle.refreshToken).toBe('refresh-token-rotated');

    const stored = harness.secretStore.store.get(
      `mangostudio:${chatGptSecretName(harness.row.id)}`
    );
    expect(stored).toBeDefined();
    expect(JSON.parse(stored as string).refreshToken).toBe('refresh-token-rotated');

    expect(harness.upserts).toHaveLength(1);
    expect(harness.upserts[0]).toMatchObject({
      id: harness.row.id,
      lastValidatedAt: NOW,
      lastValidationError: null,
    });
  });

  it('single-flights concurrent refreshes for the same connector', async () => {
    const harness = makeHarness({ bundleExpiresAt: NOW - 1_000 });

    const [a, b, c] = await Promise.all([
      harness.service.ensureFreshTokens(harness.row),
      harness.service.ensureFreshTokens(harness.row),
      harness.service.ensureFreshTokens(harness.row),
    ]);

    expect(harness.refreshCalls()).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('maps invalid_grant to ChatGptReauthRequiredError and keeps the connector row', async () => {
    const harness = makeHarness({
      bundleExpiresAt: NOW - 1_000,
      tokenEndpoint: () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });

    await expect(harness.service.ensureFreshTokens(harness.row)).rejects.toBeInstanceOf(
      ChatGptReauthRequiredError
    );
    expect(harness.upserts).toHaveLength(0);
  });

  it('refreshes again after a completed refresh (single-flight entry is cleared)', async () => {
    let expiresIn = 1; // first refresh returns a token already inside the skew window
    const harness = makeHarness({
      bundleExpiresAt: NOW - 1_000,
      tokenEndpoint: () =>
        new Response(JSON.stringify(makeTokenEndpointResponse({ expires_in: expiresIn })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await harness.service.ensureFreshTokens(harness.row);
    expiresIn = 3_600;
    await harness.service.ensureFreshTokens(harness.row);

    expect(harness.refreshCalls()).toBe(2);
  });

  it('throws a typed error when no bundle is stored', async () => {
    const harness = makeHarness({ bundleExpiresAt: NOW + 120_000 });

    await expect(
      harness.service.ensureFreshTokens(makeConnectorRow('missing'))
    ).rejects.toBeInstanceOf(ChatGptOAuthError);
  });
});
