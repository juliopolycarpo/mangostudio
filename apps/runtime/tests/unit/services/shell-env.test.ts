import { describe, expect, it } from 'bun:test';
import {
  isSecretEnvKey,
  isSecretEnvValue,
  sanitizeShellEnv,
} from '../../../src/services/shell-env';

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

describe('isSecretEnvValue', () => {
  it('detects credentials embedded in a connection URL', () => {
    expect(isSecretEnvValue('postgres://app:hunter2@db.internal:5432/main')).toBe(true);
    expect(isSecretEnvValue('redis://:hunter2@cache:6379')).toBe(true);
    expect(isSecretEnvValue('mongodb+srv://user:pw@cluster.example.com/db')).toBe(true);
  });

  it('leaves credential-free URLs alone', () => {
    expect(isSecretEnvValue('https://api.example.com/v1')).toBe(false);
    expect(isSecretEnvValue('http://localhost:3000')).toBe(false);
    expect(isSecretEnvValue('file:///srv/data')).toBe(false);
    // A path, not a URL, even though it contains a colon and an at sign.
    expect(isSecretEnvValue('/usr/bin:/opt/a@b/bin')).toBe(false);
  });
});

describe('sanitizeShellEnv', () => {
  const SOURCE = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    OPENAI_API_KEY_MAIN: 'sk-leak',
    BETTER_AUTH_SECRET: 'auth-secret',
    GITHUB_TOKEN: 'ghp-token',
  };

  it('drops secret-shaped keys but forwards the rest by default', () => {
    const env = sanitizeShellEnv({}, SOURCE);

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.OPENAI_API_KEY_MAIN).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('forwards an allowlisted secret-shaped variable', () => {
    const env = sanitizeShellEnv({ allow: ['GITHUB_TOKEN'] }, SOURCE);

    expect(env.GITHUB_TOKEN).toBe('ghp-token');
    // Other secrets are still withheld.
    expect(env.OPENAI_API_KEY_MAIN).toBeUndefined();
  });

  it('withholds credential-bearing URLs whose names look ordinary', () => {
    const env = sanitizeShellEnv(
      {},
      {
        DATABASE_URL: 'postgres://app:hunter2@db.internal:5432/main',
        BASE_URL: 'https://app.example.com',
      }
    );

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.BASE_URL).toBe('https://app.example.com');
  });

  it('lets an allowlist override value-based credential detection', () => {
    const env = sanitizeShellEnv(
      { allow: ['DATABASE_URL'] },
      { DATABASE_URL: 'postgres://app:hunter2@db.internal:5432/main' }
    );

    expect(env.DATABASE_URL).toBe('postgres://app:hunter2@db.internal:5432/main');
  });

  it('withholds an extra denylisted variable that is not secret-shaped', () => {
    const env = sanitizeShellEnv({ deny: ['HOME'] }, SOURCE);

    expect(env.HOME).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('lets deny win over allow for the same variable', () => {
    const env = sanitizeShellEnv({ allow: ['GITHUB_TOKEN'], deny: ['GITHUB_TOKEN'] }, SOURCE);

    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('skips undefined values so the result is a clean string map', () => {
    const env = sanitizeShellEnv({}, { PATH: '/usr/bin', MISSING: undefined });

    expect(env.PATH).toBe('/usr/bin');
    expect('MISSING' in env).toBe(false);
  });

  it('defaults to the live process environment', () => {
    const env = sanitizeShellEnv();
    // PATH is present on every CI/runtime; secrets must never appear.
    expect(Object.keys(env).every((key) => !isSecretEnvKey(key))).toBe(true);
  });
});
