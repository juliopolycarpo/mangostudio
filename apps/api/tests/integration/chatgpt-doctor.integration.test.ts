/**
 * End-to-end run of the doctor ChatGPT section against the fake ChatGPT
 * server: real token service, real HTTP probes, real port probe — only the
 * secret store and connector metadata are in-memory fakes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import {
  type ChatGptDoctorDeps,
  collectChatGptDoctorChecks,
  probeLoopbackPortFree,
} from '../../src/cli/chatgpt-doctor-checks';
import type { MangoConfig } from '../../src/lib/config';
import {
  chatGptSecretName,
  createChatGptTokenService,
} from '../../src/modules/connectors/infrastructure/chatgpt/token-service';
import { makeTokenBundle } from '../support/chatgpt';
import { type FakeChatGptServer, startFakeChatGptServer } from '../support/chatgpt/fake-server';
import {
  createMockSecretStore,
  type InMemorySecretStore,
} from '../support/mocks/mock-secret-store';

const CONNECTOR_ID = 'doctor-connector-1';

let fakeChatGpt: FakeChatGptServer;
let secretStore: InMemorySecretStore;

beforeEach(() => {
  fakeChatGpt = startFakeChatGptServer();
  secretStore = createMockSecretStore();
});

afterEach(() => {
  fakeChatGpt.stop();
});

function makeConfig(): MangoConfig {
  return {
    chatgpt: {
      authBaseUrl: fakeChatGpt.authBaseUrl,
      apiBaseUrl: fakeChatGpt.apiBaseUrl,
    },
  } as MangoConfig;
}

function makeConnectorRow(): SecretMetadataRow {
  return {
    id: CONNECTOR_ID,
    name: 'chatgpt-doctor',
    provider: 'chatgpt',
    configured: 1,
    source: 'bun-secrets',
    maskedSuffix: null,
    updatedAt: Date.now(),
    lastValidatedAt: null,
    lastValidationError: null,
    enabledModels: '[]',
    userId: 'user-1',
    baseUrl: null,
  };
}

async function seedBundle(expiresAt: number): Promise<void> {
  await secretStore.setSecret(
    { service: 'mangostudio', name: chatGptSecretName(CONNECTOR_ID) },
    JSON.stringify(makeTokenBundle({ refreshToken: fakeChatGpt.initialRefreshToken, expiresAt }))
  );
}

function makeDeps(): ChatGptDoctorDeps {
  const tokenService = createChatGptTokenService({
    secretStore,
    authBaseUrl: fakeChatGpt.authBaseUrl,
    upsertMetadata: () => Promise.resolve(),
  });
  return {
    secretStore,
    readBundle: (connector) => tokenService.readBundle(connector.id),
    refreshTokens: (connector) => tokenService.forceRefreshTokens(connector),
    isPortFree: probeLoopbackPortFree,
    fetchImpl: fetch,
    now: () => Date.now(),
    timeoutMs: 2_000,
  };
}

function find(results: Awaited<ReturnType<typeof collectChatGptDoctorChecks>>, label: string) {
  const row = results.find((result) => result.label === label);
  if (!row) throw new Error(`missing check row: ${label}`);
  return row;
}

describe('doctor ChatGPT section (integration)', () => {
  it('reads token state and probes the fake endpoints without refreshing', async () => {
    await seedBundle(Date.now() + 3_600_000);

    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow()],
      false,
      makeDeps()
    );

    expect(find(results, 'ChatGPT secrets').status).toBe('ok');
    expect(find(results, 'ChatGPT tokens').status).toBe('ok');
    expect(find(results, 'ChatGPT auth').status).toBe('ok');
    expect(find(results, 'ChatGPT backend').status).toBe('ok');
    expect(fakeChatGpt.countTokenRequests()).toBe(0);
    expect(secretStore.store.has('mangostudio:__doctor-write-probe__')).toBe(false);
  });

  it('fails the storage check when token-sized writes are rejected (Windows blob limit)', async () => {
    secretStore.setSecret = () =>
      Promise.reject(new Error('The stub received bad data. (code: 1783)'));

    const results = await collectChatGptDoctorChecks(makeConfig(), [], false, makeDeps());

    const secrets = find(results, 'ChatGPT secrets');
    expect(secrets.status).toBe('fail');
    expect(secrets.detail).toContain('code: 1783');
  });

  it('rotates and persists the refresh token with the live refresh probe', async () => {
    await seedBundle(Date.now() - 60_000);

    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow()],
      true,
      makeDeps()
    );

    expect(find(results, 'ChatGPT tokens').status).toBe('warn');
    const refresh = find(results, 'ChatGPT refresh');
    expect(refresh.status).toBe('ok');
    expect(refresh.detail).toContain('refresh token rotated');
    expect(fakeChatGpt.countTokenRequests('refresh_token')).toBe(1);

    const persisted = await secretStore.getSecret({
      service: 'mangostudio',
      name: chatGptSecretName(CONNECTOR_ID),
    });
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted as string).refreshToken).toBe(fakeChatGpt.currentRefreshToken);
  });

  it('reports invalid_grant from the refresh probe as a re-auth failure', async () => {
    await seedBundle(Date.now() + 3_600_000);
    fakeChatGpt.queueTokenFailure({ grantType: 'refresh_token', failure: 'invalid-grant' });

    const results = await collectChatGptDoctorChecks(
      makeConfig(),
      [makeConnectorRow()],
      true,
      makeDeps()
    );

    const refresh = find(results, 'ChatGPT refresh');
    expect(refresh.status).toBe('fail');
    expect(refresh.detail).toContain('invalid_grant');
  });
});
