import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  getConfigEnvFilePath,
  loadConfigForTest,
  resetConfig,
  resetSecretEnvTracking,
} from '../../../src/lib/config';
import {
  persistSecret,
  removeSecret,
} from '../../../src/modules/connectors/infrastructure/secret-persistence';

const CONNECTOR_ENV_VAR = 'GEMINI_API_KEY_DEFAULT';
const SECRET_VALUE = 'sk-regression-test-key';

const TMP_DIR = join('/tmp', `mango-secret-persistence-test-${process.pid}`);
let envVarSnapshot: string | undefined;

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  loadConfigForTest({ configFilePath: join(TMP_DIR, 'config.toml') });
  resetSecretEnvTracking();
  envVarSnapshot = process.env[CONNECTOR_ENV_VAR];
  delete process.env[CONNECTOR_ENV_VAR];
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  if (envVarSnapshot === undefined) {
    delete process.env[CONNECTOR_ENV_VAR];
  } else {
    process.env[CONNECTOR_ENV_VAR] = envVarSnapshot;
  }
  resetConfig();
  resetSecretEnvTracking();
});

describe('persistSecret environment source', () => {
  it('reloads the new secret into process.env so it resolves immediately', async () => {
    await persistSecret('regression-test-id', 'Default', 'gemini', 'environment', SECRET_VALUE);

    expect(process.env[CONNECTOR_ENV_VAR]).toBe(SECRET_VALUE);
    expect(readFileSync(getConfigEnvFilePath(join(TMP_DIR, 'config.toml')), 'utf8')).toContain(
      CONNECTOR_ENV_VAR
    );
  });

  it('drops the secret from process.env after removeSecret', async () => {
    await persistSecret('regression-test-id', 'Default', 'gemini', 'environment', SECRET_VALUE);
    expect(process.env[CONNECTOR_ENV_VAR]).toBe(SECRET_VALUE);

    await removeSecret('regression-test-id', 'Default', 'gemini', 'environment');

    expect(process.env[CONNECTOR_ENV_VAR]).toBeUndefined();
  });
});
