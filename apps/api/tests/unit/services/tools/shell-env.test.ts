import { describe, expect, it } from 'bun:test';
import {
  isSecretEnvKey,
  sanitizeShellEnv,
} from '../../../../src/services/tools/builtin/_shell-env';

describe('isSecretEnvKey', () => {
  it('flags connector API keys in every shape', () => {
    expect(isSecretEnvKey('GEMINI_API_KEY')).toBe(true);
    expect(isSecretEnvKey('OPENAI_API_KEY_MAIN')).toBe(true);
    expect(isSecretEnvKey('ANTHROPIC_API_KEY')).toBe(true);
  });

  it('flags the app auth secret and common credential shapes', () => {
    expect(isSecretEnvKey('BETTER_AUTH_SECRET')).toBe(true);
    expect(isSecretEnvKey('GITHUB_TOKEN')).toBe(true);
    expect(isSecretEnvKey('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(isSecretEnvKey('DB_PASSWORD')).toBe(true);
    expect(isSecretEnvKey('MY_CREDENTIALS')).toBe(true);
    expect(isSecretEnvKey('SSH_PRIVATE_KEY')).toBe(true);
  });

  it('keeps ordinary system and networking variables', () => {
    for (const key of ['PATH', 'HOME', 'NODE_ENV', 'LANG', 'TMPDIR', 'HTTPS_PROXY']) {
      expect(isSecretEnvKey(key)).toBe(false);
    }
  });
});

describe('sanitizeShellEnv', () => {
  it('drops secret-shaped keys but forwards the rest', () => {
    const env = sanitizeShellEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      OPENAI_API_KEY_MAIN: 'sk-leak',
      BETTER_AUTH_SECRET: 'auth-secret',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.OPENAI_API_KEY_MAIN).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it('skips undefined values so the result is a clean string map', () => {
    const env = sanitizeShellEnv({ PATH: '/usr/bin', MISSING: undefined });

    expect(env.PATH).toBe('/usr/bin');
    expect('MISSING' in env).toBe(false);
  });

  it('defaults to the live process environment', () => {
    const env = sanitizeShellEnv();
    // PATH is present on every CI/runtime; secrets must never appear.
    expect(Object.keys(env).every((key) => !isSecretEnvKey(key))).toBe(true);
  });
});
