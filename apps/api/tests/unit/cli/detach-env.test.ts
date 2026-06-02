import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildDetachedEnv } from '../../../src/cli/detach';

const CONNECTOR_ENV_VARS = [
  'GEMINI_API_KEY_DEFAULT',
  'OPENAI_API_KEY_MAIN',
  'ANTHROPIC_API_KEY_DEFAULT',
  'DEEPSEEK_API_KEY_DEFAULT',
  'OPENAI_API_KEY_COMPAT',
];

// Every env key any test in this file mutates. Snapshot and restore them so
// state never leaks into sibling tests or other suites in the same run.
const MUTATED_ENV_KEYS = [
  ...CONNECTOR_ENV_VARS,
  'DATABASE_PATH',
  'BETTER_AUTH_SECRET',
  'FRONTEND_PORT',
  'MANGOSTUDIO_DIAGNOSTIC_LOGS',
  'SOME_RANDOM_VAR',
  'ANOTHER_SECRET',
];

let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const key of MUTATED_ENV_KEYS) {
    envSnapshot[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of MUTATED_ENV_KEYS) {
    const original = envSnapshot[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

describe('buildDetachedEnv', () => {
  it('includes explicit spawn parameters', () => {
    const env = buildDetachedEnv('localhost', 3001, '/tmp/server.log');

    expect(env.API_HOST).toBe('localhost');
    expect(env.API_PORT).toBe('3001');
    expect(env.MANGO_LOG_FILE).toBe('/tmp/server.log');
  });

  it('does not forward connector secret env vars', () => {
    for (const key of CONNECTOR_ENV_VARS) {
      process.env[key] = 'sk-fake-leaked-key';
    }

    const env = buildDetachedEnv('localhost', 3001, '/tmp/server.log');

    for (const key of CONNECTOR_ENV_VARS) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('forwards allowlisted runtime configuration variables when set', () => {
    process.env.DATABASE_PATH = '/custom/sqlite.db';
    process.env.BETTER_AUTH_SECRET = 'a-valid-secret-at-least-32-characters-long';
    process.env.FRONTEND_PORT = '9999';

    const env = buildDetachedEnv('localhost', 3001, '/tmp/server.log');

    expect(env.DATABASE_PATH).toBe('/custom/sqlite.db');
    expect(env.BETTER_AUTH_SECRET).toBe('a-valid-secret-at-least-32-characters-long');
    expect(env.FRONTEND_PORT).toBe('9999');
  });

  it('never includes keys outside the allowlist', () => {
    process.env.SOME_RANDOM_VAR = 'should-not-appear';
    process.env.ANOTHER_SECRET = 'should-not-leak';

    const env = buildDetachedEnv('localhost', 3001, '/tmp/server.log');

    expect(env.SOME_RANDOM_VAR).toBeUndefined();
    expect(env.ANOTHER_SECRET).toBeUndefined();
  });

  it('preserves diagnostic log toggle when set to 0', () => {
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '0';

    const env = buildDetachedEnv('localhost', 3001, '/tmp/server.log');

    expect(env.MANGOSTUDIO_DIAGNOSTIC_LOGS).toBe('0');
  });

  it('never includes secret env variable names', () => {
    for (const key of CONNECTOR_ENV_VARS) {
      process.env[key] = 'sk-should-not-leak';
    }

    const env = buildDetachedEnv('localhost', 3001, '/tmp/server.log');

    for (const key of CONNECTOR_ENV_VARS) {
      expect(env).not.toHaveProperty(key);
    }
  });
});
