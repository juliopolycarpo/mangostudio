import { describe, expect, it } from 'bun:test';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import {
  createGeminiSecretService,
  InvalidGeminiApiKeyError,
} from '../../../src/services/gemini';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

function createMetadataHarness(initial: SecretMetadataRow | null = null) {
  let row = initial;

  return {
    getMetadata: async () => row,
    upsertMetadata: async (input: {
      provider: string;
      configured: boolean;
      source: 'bun-secrets' | 'environment' | 'none';
      maskedSuffix?: string;
      updatedAt: number;
      lastValidatedAt?: number;
      lastValidationError?: string;
    }) => {
      row = {
        provider: input.provider,
        configured: input.configured ? 1 : 0,
        source: input.source,
        maskedSuffix: input.maskedSuffix ?? null,
        updatedAt: input.updatedAt,
        lastValidatedAt: input.lastValidatedAt ?? null,
        lastValidationError: input.lastValidationError ?? null,
      };
    },
    getCurrentRow: () => row,
  };
}

describe('createGeminiSecretService', () => {
  it('prefers Bun.secrets over environment fallback', async () => {
    const secretStore = new InMemorySecretStore();
    await secretStore.setSecret(
      { service: 'mangostudio', name: 'gemini-api-key' },
      'stored-key-1234'
    );
    const metadata = createMetadataHarness();
    const service = createGeminiSecretService({
      secretStore,
      getEnvironmentKey: () => 'env-key-9999',
      fetchImpl: async () => new Response('{}', { status: 200 }),
      getMetadata: metadata.getMetadata,
      upsertMetadata: metadata.upsertMetadata,
    });

    const status = await service.getGeminiSecretStatus();
    const resolvedKey = await service.getResolvedGeminiApiKey();

    expect(status.source).toBe('bun-secrets');
    expect(status.maskedSuffix).toBe('1234');
    expect(resolvedKey).toBe('stored-key-1234');
  });

  it('returns environment fallback when no stored key exists', async () => {
    const metadata = createMetadataHarness();
    const service = createGeminiSecretService({
      secretStore: new InMemorySecretStore(),
      getEnvironmentKey: () => 'env-key-5678',
      fetchImpl: async () => new Response('{}', { status: 200 }),
      getMetadata: metadata.getMetadata,
      upsertMetadata: metadata.upsertMetadata,
    });

    const status = await service.getGeminiSecretStatus();

    expect(status.source).toBe('environment');
    expect(status.maskedSuffix).toBe('5678');
    expect(status.configured).toBe(true);
  });

  it('updates cache and metadata after save and delete', async () => {
    const secretStore = new InMemorySecretStore();
    const metadata = createMetadataHarness();
    let nowValue = 1_700_000_000_000;

    const service = createGeminiSecretService({
      secretStore,
      getEnvironmentKey: () => undefined,
      fetchImpl: async () => new Response('{}', { status: 200 }),
      now: () => nowValue,
      getMetadata: metadata.getMetadata,
      upsertMetadata: metadata.upsertMetadata,
    });

    const savedStatus = await service.upsertGeminiSecret('new-stored-key-4321');
    expect(savedStatus.source).toBe('bun-secrets');
    expect(await service.getResolvedGeminiApiKey()).toBe('new-stored-key-4321');
    expect(metadata.getCurrentRow()?.lastValidatedAt).toBe(nowValue);

    nowValue += 50;
    await service.deleteGeminiSecret();

    const deletedStatus = await service.getGeminiSecretStatus();
    expect(deletedStatus.source).toBe('none');
    expect(deletedStatus.configured).toBe(false);
    expect(metadata.getCurrentRow()?.updatedAt).toBe(nowValue);
    expect(metadata.getCurrentRow()?.lastValidatedAt).toBeNull();
  });

  it('does not replace the current stored key when validation fails', async () => {
    const secretStore = new InMemorySecretStore();
    await secretStore.setSecret(
      { service: 'mangostudio', name: 'gemini-api-key' },
      'existing-key-1111'
    );
    const metadata = createMetadataHarness({
      provider: 'gemini',
      configured: 1,
      source: 'bun-secrets',
      maskedSuffix: '1111',
      updatedAt: 100,
      lastValidatedAt: 100,
      lastValidationError: null,
    });

    const service = createGeminiSecretService({
      secretStore,
      getEnvironmentKey: () => undefined,
      fetchImpl: async () => new Response('{}', { status: 401 }),
      getMetadata: metadata.getMetadata,
      upsertMetadata: metadata.upsertMetadata,
    });

    let thrownError: unknown = null;

    try {
      await service.upsertGeminiSecret('bad-key-2222');
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(InvalidGeminiApiKeyError);
    expect(await service.getResolvedGeminiApiKey()).toBe('existing-key-1111');
    expect(metadata.getCurrentRow()?.maskedSuffix).toBe('1111');
  });

  it('marks storage as unavailable without breaking environment fallback status', async () => {
    const secretStore = new InMemorySecretStore();
    secretStore.available = false;
    const metadata = createMetadataHarness();
    const service = createGeminiSecretService({
      secretStore,
      getEnvironmentKey: () => 'env-key-7777',
      fetchImpl: async () => new Response('{}', { status: 200 }),
      getMetadata: metadata.getMetadata,
      upsertMetadata: metadata.upsertMetadata,
    });

    const status = await service.getGeminiSecretStatus();

    expect(status.source).toBe('environment');
    expect(status.storageAvailable).toBe(false);
  });
});
