import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

describe('persistSecret config-file source', () => {
  const CONFIG_PATH = join(TMP_DIR, 'config.toml');

  it('creates config.toml with owner-only permissions and stores the key', async () => {
    await persistSecret('config-id', 'Default', 'gemini', 'config-file', SECRET_VALUE);

    const content = readFileSync(CONFIG_PATH, 'utf8');
    expect(content).toContain('[gemini_api_keys]');
    expect(content).toContain(SECRET_VALUE);
    if (process.platform !== 'win32') {
      expect(statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
    }
  });

  it('removes only the named key and leaves the file when it is absent', async () => {
    await persistSecret('config-id', 'Default', 'gemini', 'config-file', SECRET_VALUE);

    await removeSecret('config-id', 'Default', 'gemini', 'config-file');
    expect(readFileSync(CONFIG_PATH, 'utf8')).not.toContain(SECRET_VALUE);

    // A second removal against the now-missing key is a no-op, not a throw.
    await removeSecret('config-id', 'Default', 'gemini', 'config-file');
  });

  it('preserves unrelated non-string config when writing and removing keys', async () => {
    writeFileSync(CONFIG_PATH, '[server]\nport = 4111\nstandalone = true\n', 'utf8');

    await persistSecret('config-id', 'Default', 'gemini', 'config-file', SECRET_VALUE);
    const afterWrite = readFileSync(CONFIG_PATH, 'utf8');
    expect(afterWrite).toContain('port = 4111');
    expect(afterWrite).toContain('standalone = true');
    expect(afterWrite).toContain(SECRET_VALUE);

    await removeSecret('config-id', 'Default', 'gemini', 'config-file');
    const afterRemove = readFileSync(CONFIG_PATH, 'utf8');
    expect(afterRemove).toContain('port = 4111');
    expect(afterRemove).toContain('standalone = true');
    expect(afterRemove).not.toContain(SECRET_VALUE);
  });
});
