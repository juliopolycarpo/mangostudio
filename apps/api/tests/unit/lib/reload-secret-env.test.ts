import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getConfigEnvFilePath,
  isReloadableSecretEnvKey,
  loadConfigForTest,
  reloadSecretEnv,
  resetConfig,
  resetSecretEnvTracking,
} from '../../../src/lib/config';

describe('isReloadableSecretEnvKey', () => {
  it('accepts connector secret keys', () => {
    expect(isReloadableSecretEnvKey('GEMINI_API_KEY_DEFAULT')).toBe(true);
    expect(isReloadableSecretEnvKey('OPENAI_API_KEY_MAIN')).toBe(true);
    expect(isReloadableSecretEnvKey('ANTHROPIC_API_KEY')).toBe(true);
  });

  it('rejects runtime-sensitive and unrelated keys', () => {
    expect(isReloadableSecretEnvKey('PATH')).toBe(false);
    expect(isReloadableSecretEnvKey('NODE_OPTIONS')).toBe(false);
    expect(isReloadableSecretEnvKey('LD_PRELOAD')).toBe(false);
    expect(isReloadableSecretEnvKey('BETTER_AUTH_SECRET')).toBe(false);
    expect(isReloadableSecretEnvKey('gemini_api_key_lower')).toBe(false);
  });
});

describe('reloadSecretEnv', () => {
  const SECRET_KEY = 'GEMINI_API_KEY_RELOADTEST';
  const TOUCHED_KEYS = [SECRET_KEY, 'NODE_OPTIONS', 'PATH'];
  const TMP_DIR = join('/tmp', `mango-reload-env-test-${process.pid}`);

  let envFilePath = '';
  const envVarSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    loadConfigForTest({ configFilePath: join(TMP_DIR, 'config.toml') });
    envFilePath = getConfigEnvFilePath(join(TMP_DIR, 'config.toml'));
    resetSecretEnvTracking();
    for (const key of TOUCHED_KEYS) {
      envVarSnapshot[key] = process.env[key];
    }
    delete process.env[SECRET_KEY];
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    for (const key of TOUCHED_KEYS) {
      const original = envVarSnapshot[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    resetConfig();
    resetSecretEnvTracking();
  });

  it('loads valid secret keys but never injects runtime-sensitive vars', () => {
    const injected = process.env.NODE_OPTIONS;
    writeFileSync(
      envFilePath,
      `${SECRET_KEY}="sk-reload-value"\nNODE_OPTIONS="--inspect-brk"\nPATH="/evil"\n`
    );

    reloadSecretEnv();

    expect(process.env[SECRET_KEY]).toBe('sk-reload-value');
    expect(process.env.NODE_OPTIONS).toBe(injected);
    expect(process.env.NODE_OPTIONS).not.toBe('--inspect-brk');
    expect(process.env.PATH).not.toBe('/evil');
  });

  it('drops a previously loaded key once the file no longer defines it', () => {
    writeFileSync(envFilePath, `${SECRET_KEY}="sk-reload-value"\n`);
    reloadSecretEnv();
    expect(process.env[SECRET_KEY]).toBe('sk-reload-value');

    writeFileSync(envFilePath, '');
    reloadSecretEnv();

    expect(process.env[SECRET_KEY]).toBeUndefined();
  });
});
