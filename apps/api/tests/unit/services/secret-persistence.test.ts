import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMangoDir, resetSecretEnvTracking } from '../../../src/lib/config';
import {
  persistSecret,
  removeSecret,
} from '../../../src/modules/connectors/infrastructure/secret-persistence';

const CONNECTOR_ENV_VAR = 'GEMINI_API_KEY_DEFAULT';
const SECRET_VALUE = 'sk-regression-test-key';

// persistSecret/removeSecret with the 'environment' source write to the real
// .mango/.env and re-sync process.env. Snapshot and restore both so these tests
// never corrupt the developer's local config or leak state into sibling tests.
const ENV_FILE_PATH = join(getMangoDir(), '.env');
let envFileSnapshot: string | null = null;
let envVarSnapshot: string | undefined;

beforeEach(() => {
  resetSecretEnvTracking();
  envFileSnapshot = existsSync(ENV_FILE_PATH) ? readFileSync(ENV_FILE_PATH, 'utf8') : null;
  envVarSnapshot = process.env[CONNECTOR_ENV_VAR];
  delete process.env[CONNECTOR_ENV_VAR];
});

afterEach(() => {
  if (envFileSnapshot === null) {
    if (existsSync(ENV_FILE_PATH)) rmSync(ENV_FILE_PATH);
  } else {
    writeFileSync(ENV_FILE_PATH, envFileSnapshot);
  }
  if (envVarSnapshot === undefined) {
    delete process.env[CONNECTOR_ENV_VAR];
  } else {
    process.env[CONNECTOR_ENV_VAR] = envVarSnapshot;
  }
  resetSecretEnvTracking();
});

describe('persistSecret environment source', () => {
  it('reloads the new secret into process.env so it resolves immediately', async () => {
    await persistSecret('regression-test-id', 'Default', 'gemini', 'environment', SECRET_VALUE);

    expect(process.env[CONNECTOR_ENV_VAR]).toBe(SECRET_VALUE);
  });

  it('drops the secret from process.env after removeSecret', async () => {
    await persistSecret('regression-test-id', 'Default', 'gemini', 'environment', SECRET_VALUE);
    expect(process.env[CONNECTOR_ENV_VAR]).toBe(SECRET_VALUE);

    await removeSecret('regression-test-id', 'Default', 'gemini', 'environment');

    expect(process.env[CONNECTOR_ENV_VAR]).toBeUndefined();
  });
});
