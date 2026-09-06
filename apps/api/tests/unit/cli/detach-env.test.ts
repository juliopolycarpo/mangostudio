import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildDetachedEnv } from '../../../src/cli/detach';
import type { MangoConfig } from '../../../src/lib/config';
import { updateCheckSkipReason } from '../../../src/modules/updates/application/update-check';

/** Checks enabled, so only the environment can produce a skip. */
const configWithCheck = {
  updates: { check: true, channel: null },
} as Pick<MangoConfig, 'updates'>;

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
  'ProgramFiles',
  'ProgramW6432',
  'MANGOSTUDIO_LAUNCHER',
  'MANGOSTUDIO_LAUNCHER_PATH',
  'NO_UPDATE_NOTIFIER',
  'DO_NOT_TRACK',
  'CI',
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

  it('forwards ProgramFiles and ProgramW6432 for the WSL executable lookup', () => {
    // wsl-executable.ts resolves the real wsl.exe under these; without them a
    // detached Windows server falls back to the System32 launcher stub and
    // brings back the console-window flash spawning wsl.exe directly avoids.
    process.env.ProgramFiles = 'C:\\Program Files';
    process.env.ProgramW6432 = 'C:\\Program Files';

    const env = buildDetachedEnv('localhost', 3001, '/tmp/server.log');

    expect(env.ProgramFiles).toBe('C:\\Program Files');
    expect(env.ProgramW6432).toBe('C:\\Program Files');
  });

  it('never includes keys outside the allowlist', () => {
    process.env.SOME_RANDOM_VAR = 'should-not-appear';
    process.env.ANOTHER_SECRET = 'should-not-leak';

    const env = buildDetachedEnv('localhost', 3001, '/tmp/server.log');

    expect(env.SOME_RANDOM_VAR).toBeUndefined();
    expect(env.ANOTHER_SECRET).toBeUndefined();
  });

  it('forwards the launcher marker, so a serve -d child still knows how it was installed', () => {
    process.env.MANGOSTUDIO_LAUNCHER = 'npm';
    process.env.MANGOSTUDIO_LAUNCHER_PATH =
      '/home/user/.bun/install/global/node_modules/.bin/mangostudio';

    const env = buildDetachedEnv('localhost', 3001, '/tmp/server.log');

    expect(env.MANGOSTUDIO_LAUNCHER).toBe('npm');
    expect(env.MANGOSTUDIO_LAUNCHER_PATH).toBe(
      '/home/user/.bun/install/global/node_modules/.bin/mangostudio'
    );
  });

  it('forwards the update-check opt-outs, so the privacy choice survives the spawn', () => {
    // `NO_UPDATE_NOTIFIER=1 mangostudio serve -d` used to skip the check in
    // the CLI process and then hand the hub an environment without it, so the
    // detached process — the one that actually runs the scheduled check —
    // went to the release host anyway.
    process.env.NO_UPDATE_NOTIFIER = '1';
    process.env.DO_NOT_TRACK = '1';
    process.env.CI = 'true';

    const env = buildDetachedEnv('localhost', 3001, '/tmp/server.log');

    expect(updateCheckSkipReason(configWithCheck, env, '0.1.1')).toBe('env');
    expect(env.NO_UPDATE_NOTIFIER).toBe('1');
    expect(env.DO_NOT_TRACK).toBe('1');
    expect(env.CI).toBe('true');
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

describe('buildDetachedEnv restart handshake', () => {
  it('names the predecessor pid only when a restart asks for it', () => {
    expect(buildDetachedEnv('localhost', 3001, '/x.log')).not.toHaveProperty(
      'MANGO_RESTART_WAIT_PID'
    );
    expect(buildDetachedEnv('localhost', 3001, '/x.log', { waitForPid: 42 })).toMatchObject({
      MANGO_RESTART_WAIT_PID: '42',
    });
  });
});
