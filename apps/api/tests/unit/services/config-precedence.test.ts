/**
 * Regression tests for configuration loading precedence.
 *
 * Verifies the four-tier hierarchy documented in config.ts:
 *   1. process.env   (highest priority)
 *   2. .env next to config.toml (file overrides)
 *   3. config.toml
 *   4. Hardcoded defaults
 *
 * Uses temporary TOML files in /tmp so the tests do not depend on the
 * presence of ~/.mango/config.toml in the developer's environment.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getConfigEnvFilePath,
  loadConfig,
  parseBooleanFlag,
  resetConfig,
} from '../../../src/lib/config';

const TMP_DIR = join('/tmp', `mango-config-test-${process.pid}`);
const TMP_TOML = join(TMP_DIR, 'config.toml');

const WATCHED_ENV_KEYS = [
  'API_PORT',
  'API_HOST',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'DATABASE_PATH',
  'UPLOADS_DIR',
  'IMAGES_DIR',
  'TRUST_PROXY',
];

function saveEnv(): Record<string, string | undefined> {
  return Object.fromEntries(WATCHED_ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

describe('config precedence', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    savedEnv = saveEnv();
    for (const k of WATCHED_ENV_KEYS) delete process.env[k];
    resetConfig();
  });

  afterEach(() => {
    resetConfig();
    restoreEnv(savedEnv);
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('loads server.port from config.toml', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 4242\n');

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.server.port).toBe(4242);
  });

  test('uses hardcoded default when config.toml is absent', () => {
    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.server.port).toBe(3001);
  });

  test('process.env API_PORT overrides config.toml server.port', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 4242\n');
    process.env.API_PORT = '9999';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.server.port).toBe(9999);
  });

  test('process.env API_PORT overrides hardcoded default', () => {
    process.env.API_PORT = '7777';

    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.server.port).toBe(7777);
  });

  test('unrelated fields keep their config.toml values when process.env overrides another field', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 4242\nhost = "0.0.0.0"\n');
    process.env.API_PORT = '9999';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.server.port).toBe(9999);
    expect(cfg.server.host).toBe('0.0.0.0');
  });

  test('invalid API_PORT in process.env falls back to config.toml value', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 4242\n');
    process.env.API_PORT = 'not-a-number';

    const cfg = loadConfig(TMP_TOML);

    // applyEnvOverrides: Number('not-a-number') = NaN; NaN || existing = existing
    expect(cfg.server.port).toBe(4242);
  });

  test('loads auth.secret from config.toml', () => {
    writeFileSync(TMP_TOML, '[auth]\nsecret = "toml-secret-at-least-32-characters"\n');

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.auth.secret).toBe('toml-secret-at-least-32-characters');
  });

  test('loads BETTER_AUTH_SECRET from .env next to config.toml', () => {
    writeFileSync(TMP_TOML, '[auth]\nsecret = "toml-secret-at-least-32-characters"\n');
    writeFileSync(
      join(TMP_DIR, '.env'),
      'BETTER_AUTH_SECRET="env-secret-at-least-32-characters"\n'
    );

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.auth.secret).toBe('env-secret-at-least-32-characters');
  });

  test('process.env BETTER_AUTH_SECRET overrides .env', () => {
    writeFileSync(
      join(TMP_DIR, '.env'),
      'BETTER_AUTH_SECRET="env-secret-at-least-32-characters"\n'
    );
    process.env.BETTER_AUTH_SECRET = 'process-secret-at-least-32-characters';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.auth.secret).toBe('process-secret-at-least-32-characters');
  });

  test('auth.url falls back to localhost when the default host is the 0.0.0.0 wildcard', () => {
    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    // The default bind host is 0.0.0.0, but that wildcard is not browser-routable,
    // so the derived Better Auth baseURL must use localhost.
    expect(cfg.server.host).toBe('0.0.0.0');
    expect(cfg.auth.url).toBe('http://localhost:3001');
  });

  test('auth.url uses an explicit non-wildcard host from config.toml', () => {
    writeFileSync(TMP_TOML, '[server]\nhost = "192.168.1.5"\nport = 4000\n');

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.auth.url).toBe('http://192.168.1.5:4000');
  });

  test('defaults images.dir to ~/.mango/images', () => {
    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.images.dir).toBe(join(process.env.HOME ?? '', '.mango', 'images'));
  });

  test('defaults database.path and uploads.dir to ~/.mango', () => {
    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.database.path).toBe(join(process.env.HOME ?? '', '.mango', 'database.sqlite'));
    expect(cfg.uploads.dir).toBe(join(process.env.HOME ?? '', '.mango', 'uploads'));
  });

  test('defaults .env path to ~/.mango next to config.toml', () => {
    expect(getConfigEnvFilePath()).toBe(join(process.env.HOME ?? '', '.mango', '.env'));
  });

  test('process.env IMAGES_DIR overrides the default images directory', () => {
    process.env.IMAGES_DIR = './tmp/generated-images';

    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.images.dir).toBe(resolve(import.meta.dir, '../../../../../tmp/generated-images'));
  });

  test('security.trustProxy defaults to false', () => {
    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.security.trustProxy).toBe(false);
  });

  test('loads security.trustProxy from config.toml', () => {
    writeFileSync(TMP_TOML, '[security]\ntrustProxy = true\n');

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.security.trustProxy).toBe(true);
  });

  test('process.env TRUST_PROXY overrides config.toml security.trustProxy', () => {
    writeFileSync(TMP_TOML, '[security]\ntrustProxy = true\n');
    process.env.TRUST_PROXY = '0';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.security.trustProxy).toBe(false);
  });

  test('process.env TRUST_PROXY enables trust over the default', () => {
    process.env.TRUST_PROXY = 'true';

    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.security.trustProxy).toBe(true);
  });
});

describe('parseBooleanFlag', () => {
  test('treats 1/true/yes/on (any case) as true', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'Yes', 'on', ' on ']) {
      expect(parseBooleanFlag(truthy)).toBe(true);
    }
  });

  test('treats everything else as false', () => {
    for (const falsy of ['0', 'false', 'no', 'off', '', 'enabled', '2']) {
      expect(parseBooleanFlag(falsy)).toBe(false);
    }
  });
});

describe('corsOrigins includes server origin for same-origin deployments', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    savedEnv = saveEnv();
    for (const k of WATCHED_ENV_KEYS) delete process.env[k];
    resetConfig();
  });

  afterEach(() => {
    resetConfig();
    restoreEnv(savedEnv);
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('server localhost origin is included by default', () => {
    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    // Default server port is 3001
    expect(cfg.corsOrigins).toContain('http://localhost:3001');
    expect(cfg.corsOrigins).toContain('http://127.0.0.1:3001');
  });

  test('server origin reflects custom port from config.toml', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 8080\n');

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.corsOrigins).toContain('http://localhost:8080');
    expect(cfg.corsOrigins).toContain('http://127.0.0.1:8080');
  });

  // Simulates the runner scripts (run.sh / run.bat) launching the binary with
  // API_PORT set to a user-chosen port. The binary reads process.env, so
  // cfg.server.port is already the resolved port when computeDerived() runs.
  // corsOrigins must include that same port so same-origin requests are accepted.
  test('API_PORT env var (set by runner scripts) is reflected in corsOrigins', () => {
    process.env.API_PORT = '13077'; // value used by the smoke test runner

    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.corsOrigins).toContain('http://localhost:13077');
    expect(cfg.corsOrigins).toContain('http://127.0.0.1:13077');
  });

  test('API_PORT overrides config.toml port and corsOrigins reflects the override', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 8080\n');
    process.env.API_PORT = '9999';

    const cfg = loadConfig(TMP_TOML);

    // env var wins over config.toml
    expect(cfg.corsOrigins).toContain('http://localhost:9999');
    expect(cfg.corsOrigins).not.toContain('http://localhost:8080');
  });

  test('custom server host is added when it differs from localhost', () => {
    writeFileSync(TMP_TOML, '[server]\nhost = "api.internal"\nport = 4000\n');

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.corsOrigins).toContain('http://api.internal:4000');
  });

  test('frontend origins are still present alongside server origin', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 3001\n[frontend]\nport = 5173\n');

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.corsOrigins).toContain('http://localhost:5173');
    expect(cfg.corsOrigins).toContain('http://localhost:3001');
  });
});
