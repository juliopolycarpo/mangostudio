import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import type { SecretMetadataInput } from '../../../../src/services/secret-store/metadata';
import {
  createProviderSecretService,
  isPlaceholderConfigSecretValue,
} from '../../../../src/services/providers/secret-service';
import { InMemorySecretStore } from '../../../support/mocks/mock-secret-store';

function createMetadataHarness(initial: SecretMetadataRow[] = []) {
  let rows: SecretMetadataRow[] = [...initial];

  return {
    listMetadata: async (_provider: string, _userId: string) => [...rows],
    getMetadataById: async (id: string, _userId: string) => rows.find((row) => row.id === id) ?? null,
    upsertMetadata: async (input: SecretMetadataInput) => {
      const nextRow: SecretMetadataRow = {
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
        organizationId: input.organizationId ?? null,
        projectId: input.projectId ?? null,
      };

      rows = [...rows.filter((row) => row.id !== input.id), nextRow];
    },
    deleteMetadata: async (id: string, _userId: string) => {
      rows = rows.filter((row) => row.id !== id);
    },
    getRows: () => rows,
  };
}

function makeRow(overrides: Partial<SecretMetadataRow> = {}): SecretMetadataRow {
  return {
    id: 'row-1',
    name: 'default',
    provider: 'openai',
    configured: 1,
    source: 'config-file',
    maskedSuffix: '****...1234',
    updatedAt: Date.now(),
    lastValidatedAt: null,
    lastValidationError: null,
    enabledModels: JSON.stringify([]),
    userId: 'test-user',
    baseUrl: null,
    organizationId: null,
    projectId: null,
    ...overrides,
  };
}

const tempDirs: string[] = [];

function writeTempToml(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-secret-service-'));
  const tomlPath = join(dir, 'config.toml');
  writeFileSync(tomlPath, contents);
  tempDirs.push(dir);
  return tomlPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('isPlaceholderConfigSecretValue', () => {
  it('flags obvious fixture keys', () => {
    expect(isPlaceholderConfigSecretValue('sk-test-openai-key-1234')).toBe(true);
    expect(isPlaceholderConfigSecretValue('sk-or-test-key-9999')).toBe(true);
    expect(isPlaceholderConfigSecretValue('your-secret-key-here')).toBe(true);
    expect(isPlaceholderConfigSecretValue('sk-live-realistic-value')).toBe(false);
  });
});

describe('createProviderSecretService syncConfigFileConnectors', () => {
  it('removes placeholder config entries instead of syncing them into metadata', async () => {
    const metadata = createMetadataHarness([
      makeRow({
        id: 'placeholder-row',
        name: 'openai-for-list',
        userId: null,
      }),
    ]);

    const service = createProviderSecretService(
      {
        provider: 'openai',
        tomlSection: 'openai_api_keys',
        envVarPrefix: 'OPENAI_API_KEY',
        validateFn: async () => {},
      },
      {
        secretStore: new InMemorySecretStore(),
        tomlFilePath: writeTempToml('[openai_api_keys]\nopenai-for-list = "sk-list-test-key-aaaa"\n'),
        listMetadata: metadata.listMetadata,
        getMetadataById: metadata.getMetadataById,
        upsertMetadata: metadata.upsertMetadata,
        deleteMetadata: metadata.deleteMetadata,
      }
    );

    await service.syncConfigFileConnectors('test-user');

    expect(metadata.getRows()).toEqual([]);
  });

  it('preserves owner and provider metadata when a config-file connector is refreshed', async () => {
    const metadata = createMetadataHarness([
      makeRow({
        id: 'owned-openai',
        name: 'real-openai',
        userId: 'user-123',
        organizationId: 'org_123',
        projectId: 'proj_123',
      }),
    ]);

    const service = createProviderSecretService(
      {
        provider: 'openai',
        tomlSection: 'openai_api_keys',
        envVarPrefix: 'OPENAI_API_KEY',
        validateFn: async () => {},
      },
      {
        secretStore: new InMemorySecretStore(),
        tomlFilePath: writeTempToml(
          '[openai_api_keys]\nreal-openai = "sk-live-updated-value-9876"\n'
        ),
        listMetadata: metadata.listMetadata,
        getMetadataById: metadata.getMetadataById,
        upsertMetadata: metadata.upsertMetadata,
        deleteMetadata: metadata.deleteMetadata,
      }
    );

    await service.syncConfigFileConnectors('user-123');

    expect(metadata.getRows()).toEqual([
      expect.objectContaining({
        id: 'owned-openai',
        userId: 'user-123',
        organizationId: 'org_123',
        projectId: 'proj_123',
      }),
    ]);
  });

  it('skips openai-compatible config-file entries that do not have persisted baseUrl metadata', async () => {
    const metadata = createMetadataHarness([
      makeRow({
        id: 'compat-row',
        name: 'openrouter-key',
        provider: 'openai-compatible',
        baseUrl: null,
        userId: null,
      }),
    ]);

    const service = createProviderSecretService(
      {
        provider: 'openai-compatible',
        tomlSection: 'openai_compatible_api_keys',
        envVarPrefix: 'OPENAI_API_KEY',
        shouldSyncConfigEntry: ({ existing }) => Boolean(existing?.baseUrl?.trim()),
        validateFn: async () => {},
      },
      {
        secretStore: new InMemorySecretStore(),
        tomlFilePath: writeTempToml(
          '[openai_compatible_api_keys]\nopenrouter-key = "sk-live-compat-value-1234"\n'
        ),
        listMetadata: metadata.listMetadata,
        getMetadataById: metadata.getMetadataById,
        upsertMetadata: metadata.upsertMetadata,
        deleteMetadata: metadata.deleteMetadata,
      }
    );

    await service.syncConfigFileConnectors('test-user');

    expect(metadata.getRows()).toEqual([]);
  });
});
