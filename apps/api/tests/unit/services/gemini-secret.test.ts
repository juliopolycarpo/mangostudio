import { describe, expect, it } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import type { SecretMetadataInput } from '../../../src/services/secret-store/metadata';
import { createGeminiSecretService, InvalidGeminiApiKeyError } from '../../../src/services/gemini';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

const TEST_USER = 'test-user';
const NO_TOML = '/tmp/mangostudio-test-nonexistent-config.toml';

function createMetadataHarness(initial: SecretMetadataRow[] = []) {
  let rows: SecretMetadataRow[] = [...initial];

  return {
    listMetadata: (_provider: string, _userId: string) => Promise.resolve([...rows]),
    getMetadataById: (id: string, _userId: string) =>
      Promise.resolve(rows.find((r) => r.id === id) ?? null),
    upsertMetadata: (input: SecretMetadataInput) => {
      const idx = rows.findIndex((r) => r.id === input.id);
      const row: SecretMetadataRow = {
        id: input.id,
        name: input.name,
        provider: input.provider,
        configured: input.configured ? 1 : 0,
        source: input.source,
        maskedSuffix: input.maskedSuffix ?? null,
        updatedAt: input.updatedAt,
        lastValidatedAt: input.lastValidatedAt ?? null,
        lastValidationError: input.lastValidationError ?? null,
        enabledModels: JSON.stringify(input.enabledModels),
        userId: input.userId,
        baseUrl: input.baseUrl ?? null,
      };
      if (idx >= 0) {
        rows[idx] = row;
      } else {
        rows.push(row);
      }
      return Promise.resolve();
    },
    deleteMetadata: (id: string, _userId: string) => {
      rows = rows.filter((r) => r.id !== id);
      return Promise.resolve();
    },
    getCurrentRows: () => rows,
  };
}

describe('createGeminiSecretService', () => {
  it('returns empty connectors when no keys are configured', async () => {
    const metadata = createMetadataHarness();
    const service = createGeminiSecretService({
      secretStore: new InMemorySecretStore(),
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 200 })),
      tomlFilePath: NO_TOML,
      listMetadata: metadata.listMetadata,
      getMetadataById: metadata.getMetadataById,
      upsertMetadata: metadata.upsertMetadata,
      deleteMetadata: metadata.deleteMetadata,
    });

    const status = await service.getGeminiSecretStatus(TEST_USER);

    expect(status.connectors).toEqual([]);
  });

  it('adds a bun-secrets connector after successful validation', async () => {
    const metadata = createMetadataHarness();
    const secretStore = new InMemorySecretStore();
    const service = createGeminiSecretService({
      secretStore,
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 200 })),
      tomlFilePath: NO_TOML,
      listMetadata: metadata.listMetadata,
      getMetadataById: metadata.getMetadataById,
      upsertMetadata: metadata.upsertMetadata,
      deleteMetadata: metadata.deleteMetadata,
    });

    const connector = await service.addGeminiConnector(TEST_USER, {
      name: 'my-key',
      apiKey: 'valid-key-1234',
      source: 'bun-secrets',
    });

    expect(connector.name).toBe('my-key');
    expect(connector.source).toBe('bun-secrets');
    expect(connector.configured).toBe(true);
    expect(connector.maskedSuffix).toBe('****...1234');

    const status = await service.getGeminiSecretStatus(TEST_USER);
    expect(status.connectors).toHaveLength(1);
    expect(status.connectors[0]?.name).toBe('my-key');
  });

  it('rejects an invalid API key and does not persist it', async () => {
    const metadata = createMetadataHarness();
    const service = createGeminiSecretService({
      secretStore: new InMemorySecretStore(),
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 401 })),
      tomlFilePath: NO_TOML,
      listMetadata: metadata.listMetadata,
      getMetadataById: metadata.getMetadataById,
      upsertMetadata: metadata.upsertMetadata,
      deleteMetadata: metadata.deleteMetadata,
    });

    let thrownError: unknown = null;
    try {
      await service.addGeminiConnector(TEST_USER, {
        name: 'bad-key',
        apiKey: 'bad-key-0000',
        source: 'bun-secrets',
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(InvalidGeminiApiKeyError);
    expect(metadata.getCurrentRows()).toHaveLength(0);
  });

  it('deletes a connector and removes it from the secret store', async () => {
    const secretStore = new InMemorySecretStore();
    const metadata = createMetadataHarness();
    let nowValue = 1_700_000_000_000;

    const service = createGeminiSecretService({
      secretStore,
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 200 })),
      now: () => nowValue,
      tomlFilePath: NO_TOML,
      listMetadata: metadata.listMetadata,
      getMetadataById: metadata.getMetadataById,
      upsertMetadata: metadata.upsertMetadata,
      deleteMetadata: metadata.deleteMetadata,
    });

    const connector = await service.addGeminiConnector(TEST_USER, {
      name: 'temp-key',
      apiKey: 'temp-key-5678',
      source: 'bun-secrets',
    });

    nowValue += 50;
    await service.deleteGeminiConnector(TEST_USER, connector.id);

    const status = await service.getGeminiSecretStatus(TEST_USER);
    expect(status.connectors).toHaveLength(0);
    expect(metadata.getCurrentRows()).toHaveLength(0);
  });

  it('returns empty connectors when secret store is unavailable and no keys are configured', async () => {
    const secretStore = new InMemorySecretStore();
    secretStore.available = false;
    const metadata = createMetadataHarness();
    const service = createGeminiSecretService({
      secretStore,
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 200 })),
      tomlFilePath: NO_TOML,
      listMetadata: metadata.listMetadata,
      getMetadataById: metadata.getMetadataById,
      upsertMetadata: metadata.upsertMetadata,
      deleteMetadata: metadata.deleteMetadata,
    });

    const status = await service.getGeminiSecretStatus(TEST_USER);

    expect(status.connectors).toEqual([]);
  });
});
