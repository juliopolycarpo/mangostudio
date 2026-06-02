import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getMangoDir,
  isReloadableSecretEnvKey,
  reloadSecretEnv,
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
  const ENV_FILE_PATH = join(getMangoDir(), '.env');

  let envFileSnapshot: string | null = null;
  const envVarSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetSecretEnvTracking();
    envFileSnapshot = existsSync(ENV_FILE_PATH) ? readFileSync(ENV_FILE_PATH, 'utf8') : null;
    for (const key of TOUCHED_KEYS) {
      envVarSnapshot[key] = process.env[key];
    }
    delete process.env[SECRET_KEY];
  });

  afterEach(() => {
    if (envFileSnapshot === null) {
      if (existsSync(ENV_FILE_PATH)) rmSync(ENV_FILE_PATH);
    } else {
      writeFileSync(ENV_FILE_PATH, envFileSnapshot);
    }
    for (const key of TOUCHED_KEYS) {
      const original = envVarSnapshot[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    resetSecretEnvTracking();
  });

  it('loads valid secret keys but never injects runtime-sensitive vars', () => {
    const injected = process.env.NODE_OPTIONS;
    writeFileSync(
      ENV_FILE_PATH,
      `${SECRET_KEY}="sk-reload-value"\nNODE_OPTIONS="--inspect-brk"\nPATH="/evil"\n`
    );

    reloadSecretEnv();

    expect(process.env[SECRET_KEY]).toBe('sk-reload-value');
    expect(process.env.NODE_OPTIONS).toBe(injected);
    expect(process.env.NODE_OPTIONS).not.toBe('--inspect-brk');
    expect(process.env.PATH).not.toBe('/evil');
  });

  it('drops a previously loaded key once the file no longer defines it', () => {
    writeFileSync(ENV_FILE_PATH, `${SECRET_KEY}="sk-reload-value"\n`);
    reloadSecretEnv();
    expect(process.env[SECRET_KEY]).toBe('sk-reload-value');

    writeFileSync(ENV_FILE_PATH, '');
    reloadSecretEnv();

    expect(process.env[SECRET_KEY]).toBeUndefined();
  });
});
