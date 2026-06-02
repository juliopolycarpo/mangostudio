import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AuthSecretStorageTarget,
  ensureServeAuthSecret,
} from '../../../src/cli/auth-secret-setup';
import { loadConfigForTest, resetConfig } from '../../../src/lib/config';

const TMP_DIR = join('/tmp', `mango-auth-secret-setup-test-${process.pid}`);
const CONFIG_PATH = join(TMP_DIR, 'config.toml');
const ENV_PATH = join(TMP_DIR, '.env');
const VALID_SECRET = 'generated-secret-at-least-32-characters';

let savedAuthSecret: string | undefined;

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  savedAuthSecret = process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_SECRET;
  resetConfig();
});

afterEach(() => {
  if (savedAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = savedAuthSecret;
  resetConfig();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('ensureServeAuthSecret', () => {
  it('stores a generated missing secret in .env', async () => {
    const lines: string[] = [];
    loadMissingAuthSecretConfig();

    await ensureServeAuthSecret(makeDeps('env', lines));

    expect(readFileSync(ENV_PATH, 'utf8')).toContain(`BETTER_AUTH_SECRET="${VALID_SECRET}"`);
    expect(process.env.BETTER_AUTH_SECRET).toBe(VALID_SECRET);
    expect(lines.join('\n')).toContain(ENV_PATH);
  });

  it('stores a generated missing secret in config.toml', async () => {
    writeFileSync(CONFIG_PATH, '[server]\nport = 4111\n');
    loadMissingAuthSecretConfig();

    await ensureServeAuthSecret(makeDeps('toml'));

    const content = readFileSync(CONFIG_PATH, 'utf8');
    expect(content).toContain('port = 4111');
    expect(content).toContain(`secret = "${VALID_SECRET}"`);
  });

  it('does not prompt when a valid secret is already configured', async () => {
    let asked = false;
    loadConfigForTest({ auth: { secret: VALID_SECRET, url: '' }, configFilePath: CONFIG_PATH });

    await ensureServeAuthSecret({
      askStorageTarget: () => {
        asked = true;
        return Promise.resolve('env');
      },
      isInteractive: () => true,
    });

    expect(asked).toBe(false);
    expect(existsSync(ENV_PATH)).toBe(false);
  });

  it('rejects a configured secret that is too short', async () => {
    let asked = false;
    loadConfigForTest({ auth: { secret: 'short', url: '' }, configFilePath: CONFIG_PATH });

    const result = ensureServeAuthSecret({
      askStorageTarget: () => {
        asked = true;
        return Promise.resolve('env');
      },
      isInteractive: () => true,
    });

    await expect(result).rejects.toThrow(/must be at least 32 characters/);
    expect(asked).toBe(false);
  });

  it('rejects a missing secret when the terminal is non-interactive', async () => {
    loadMissingAuthSecretConfig();

    const result = ensureServeAuthSecret({ isInteractive: () => false });

    await expect(result).rejects.toThrow(/interactive terminal/);
    expect(existsSync(ENV_PATH)).toBe(false);
  });
});

function loadMissingAuthSecretConfig(): void {
  loadConfigForTest({ auth: { secret: '', url: '' }, configFilePath: CONFIG_PATH });
}

function makeDeps(target: AuthSecretStorageTarget, lines: string[] = []) {
  return {
    askStorageTarget: () => Promise.resolve(target),
    generateSecret: () => VALID_SECRET,
    isInteractive: () => true,
    log: (message: string) => lines.push(message),
  };
}
