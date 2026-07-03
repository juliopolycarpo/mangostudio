import { describe, expect, it } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import {
  type ChatGptDoctorDeps,
  collectChatGptDoctorChecks,
} from '../../../src/cli/chatgpt-doctor-checks';
import type { MangoConfig } from '../../../src/lib/config';
import {
  CHATGPT_REAUTH_REQUIRED_CODE,
  ChatGptReauthRequiredError,
} from '../../../src/modules/connectors/infrastructure/chatgpt/oauth-client';
import { SecretStorageUnavailableError } from '../../../src/services/secret-store/store';
import { makeTokenBundle } from '../../support/chatgpt';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

const NOW = 1_750_000_000_000;

function makeConfig(): MangoConfig {
  return {
    chatgpt: {
      authBaseUrl: 'https://auth.example.test',
      apiBaseUrl: 'https://api.example.test',
    },
  } as MangoConfig;
}

function makeConnectorRow(overrides: Partial<SecretMetadataRow> = {}): SecretMetadataRow {
  return {
    id: 'connector-1',
    name: 'chatgpt-main',
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
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ChatGptDoctorDeps> = {}): ChatGptDoctorDeps {
  return {
    secretStore: new InMemorySecretStore(),
    readBundle: () => Promise.resolve(makeTokenBundle({ expiresAt: NOW + 3_600_000 })),
    refreshTokens: () => Promise.resolve(makeTokenBundle({ expiresAt: NOW + 3_600_000 })),
    isPortFree: () => Promise.resolve(true),
    fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
    now: () => NOW,
    timeoutMs: 200,
    ...overrides,
  };
}

function find(results: Awaited<ReturnType<typeof collectChatGptDoctorChecks>>, label: string) {
  const row = results.find((result) => result.label === label);
  if (!row) throw new Error(`missing check row: ${label}`);
  return row;
}

describe('collectChatGptDoctorChecks', () => {
  it('reports a healthy connector without touching the refresh probe', async () => {
    let refreshed = false;
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow()],
      false,
      makeDeps({
        refreshTokens: () => {
          refreshed = true;
          return Promise.resolve(makeTokenBundle());
        },
      })
    );

    expect(find(results, 'ChatGPT secrets').status).toBe('ok');
    const tokens = find(results, 'ChatGPT tokens');
    expect(tokens.status).toBe('ok');
    expect(tokens.detail).toContain('****...');
    expect(tokens.detail).toContain('expires in 1h 0m');
    expect(tokens.detail).not.toContain('user@example.com');
    expect(results.some((result) => result.label === 'ChatGPT refresh')).toBe(false);
    expect(refreshed).toBe(false);
    expect(find(results, 'ChatGPT port').status).toBe('ok');
    expect(find(results, 'ChatGPT auth').detail).toContain('HTTP 200');
    expect(find(results, 'ChatGPT backend').detail).toContain('HTTP 200');
  });

  it('fails secret storage when the store is unavailable', async () => {
    const store = new InMemorySecretStore();
    store.available = false;
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [],
      false,
      makeDeps({ secretStore: store })
    );

    const storage = find(results, 'ChatGPT secrets');
    expect(storage.status).toBe('fail');
    expect(storage.detail).toContain('unavailable');
  });

  it('fails the token row when the bundle is missing or unreadable', async () => {
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow()],
      false,
      makeDeps({
        readBundle: () =>
          Promise.reject(new SecretStorageUnavailableError('OS secret storage is unavailable')),
      })
    );

    const tokens = find(results, 'ChatGPT tokens');
    expect(tokens.status).toBe('fail');
    expect(tokens.detail).toContain('chatgpt-main');
    expect(tokens.detail).toContain('unavailable');
  });

  it('warns when the access token is expired', async () => {
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow()],
      false,
      makeDeps({
        readBundle: () => Promise.resolve(makeTokenBundle({ expiresAt: NOW - 180_000 })),
      })
    );

    const tokens = find(results, 'ChatGPT tokens');
    expect(tokens.status).toBe('warn');
    expect(tokens.detail).toContain('expired 3m ago');
    expect(tokens.detail).toContain('refreshes on next use');
  });

  it('fails the token row when the connector is flagged for re-auth', async () => {
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow({ lastValidationError: CHATGPT_REAUTH_REQUIRED_CODE })],
      false,
      makeDeps()
    );

    const tokens = find(results, 'ChatGPT tokens');
    expect(tokens.status).toBe('fail');
    expect(tokens.detail).toContain('sign in with ChatGPT again');
  });

  it('reports a successful refresh rotation with --chatgpt-refresh', async () => {
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow()],
      true,
      makeDeps({
        refreshTokens: () => Promise.resolve(makeTokenBundle({ expiresAt: NOW + 3_600_000 })),
      })
    );

    const refresh = find(results, 'ChatGPT refresh');
    expect(refresh.status).toBe('ok');
    expect(refresh.detail).toContain('refresh token rotated');
  });

  it('fails the refresh row on invalid_grant', async () => {
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow()],
      true,
      makeDeps({
        refreshTokens: () => Promise.reject(new ChatGptReauthRequiredError()),
      })
    );

    const refresh = find(results, 'ChatGPT refresh');
    expect(refresh.status).toBe('fail');
    expect(refresh.detail).toContain('invalid_grant');
    expect(refresh.detail).toContain('sign in with ChatGPT again');
  });

  it('skips the refresh probe when the bundle is unreadable', async () => {
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow()],
      true,
      makeDeps({
        readBundle: () => Promise.reject(new Error('No stored ChatGPT tokens found.')),
        refreshTokens: () => Promise.reject(new Error('should not be called')),
      })
    );

    const refresh = find(results, 'ChatGPT refresh');
    expect(refresh.status).toBe('fail');
    expect(refresh.detail).toContain('skipped');
  });

  it('bounds a hanging refresh probe with the probe timeout', async () => {
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow()],
      true,
      makeDeps({
        timeoutMs: 20,
        refreshTokens: () => new Promise(() => undefined),
      })
    );

    const refresh = find(results, 'ChatGPT refresh');
    expect(refresh.status).toBe('fail');
    expect(refresh.detail).toContain('timed out');
  });

  it('warns when the callback port is already bound', async () => {
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [],
      false,
      makeDeps({ isPortFree: () => Promise.resolve(false) })
    );

    const port = find(results, 'ChatGPT port');
    expect(port.status).toBe('warn');
    expect(port.detail).toContain('1455 in use');
  });

  it('reports HTTP status for reachable endpoints and fails on network errors', async () => {
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [],
      false,
      makeDeps({
        fetchImpl: (input) => {
          if (new URL(String(input)).host === 'auth.example.test') {
            return Promise.resolve(new Response(null, { status: 403 }));
          }
          return Promise.reject(new Error('getaddrinfo ENOTFOUND api.example.test'));
        },
      })
    );

    const auth = find(results, 'ChatGPT auth');
    expect(auth.status).toBe('ok');
    expect(auth.detail).toContain('HTTP 403');

    const backend = find(results, 'ChatGPT backend');
    expect(backend.status).toBe('fail');
    expect(backend.detail).toContain('ENOTFOUND');
  });

  it('bounds an unresponsive endpoint probe with the probe timeout', async () => {
    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [],
      false,
      makeDeps({
        timeoutMs: 20,
        fetchImpl: (_input, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      })
    );

    expect(find(results, 'ChatGPT auth').status).toBe('fail');
    expect(find(results, 'ChatGPT auth').detail).toContain('timed out');
  });
});
