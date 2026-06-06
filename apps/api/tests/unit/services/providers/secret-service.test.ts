import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import { getConfig, loadConfigForTest } from '../../../../src/lib/config';
import {
  createProviderSecretService,
  isPlaceholderConfigSecretValue,
} from '../../../../src/services/providers/core/secret-service';
import type { SecretMetadataInput } from '../../../../src/services/secret-store/metadata';
import { InMemorySecretStore } from '../../../support/mocks/mock-secret-store';

function createMetadataHarness(initial: SecretMetadataRow[] = []) {
  let rows: SecretMetadataRow[] = [...initial];

  return {
    listMetadata: (_provider: string, _userId: string) => Promise.resolve([...rows]),
    getMetadataById: (id: string, _userId: string) =>
      Promise.resolve(rows.find((row) => row.id === id) ?? null),
    upsertMetadata: (input: SecretMetadataInput) => {
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
      return Promise.resolve();
    },
    deleteMetadata: (id: string, _userId: string) => {
      rows = rows.filter((row) => row.id !== id);
      return Promise.resolve();
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

describe('createProviderSecretService config path resolution', () => {
  // The active config is a shared process singleton. Snapshot the values the
  // test preload installed and restore them so mutating the config here cannot
  // leak into sibling test files that run in the same Bun process.
  const savedAuth = { ...getConfig().auth };
  const savedConfigFilePath = getConfig().configFilePath;

  function setActiveConfigFilePath(configFilePath: string): void {
    loadConfigForTest({ database: { path: ':memory:' }, auth: savedAuth, configFilePath });
  }

  afterEach(() => {
    setActiveConfigFilePath(savedConfigFilePath);
  });

  it('reads getConfig().configFilePath at use time, not at construction time', () => {
    const pathA = writeTempToml('[openai_api_keys]\na = "sk-live-aaaa"\n');
    const pathB = writeTempToml('[openai_api_keys]\nb = "sk-live-bbbb"\n');

    setActiveConfigFilePath(pathA);

    const service = createProviderSecretService({
      provider: 'openai',
      tomlSection: 'openai_api_keys',
      envVarPrefix: 'OPENAI_API_KEY',
      validateFn: () => Promise.resolve(),
    });

    expect(service.tomlFilePath).toBe(pathA);

    // Regression: a config switch after construction must be reflected. A path
    // captured at construction (the previous bug) would freeze on pathA and let
    // the developer's real ~/.mango/config.toml leak into the in-memory test DB.
    setActiveConfigFilePath(pathB);
    expect(service.tomlFilePath).toBe(pathB);
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
        validateFn: () => Promise.resolve(),
      },
      {
        secretStore: new InMemorySecretStore(),
        tomlFilePath: writeTempToml(
          '[openai_api_keys]\nopenai-for-list = "sk-list-test-key-aaaa"\n'
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
        validateFn: () => Promise.resolve(),
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

    const rows = metadata.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'owned-openai',
      userId: 'user-123',
      organizationId: 'org_123',
      projectId: 'proj_123',
    });
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
        validateFn: () => Promise.resolve(),
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
