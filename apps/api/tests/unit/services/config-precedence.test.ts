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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CliError } from '../../../src/cli/errors';
import {
  getConfigEnvFilePath,
  loadConfig,
  loadConfigForTest,
  parseBooleanFlag,
  RUNTIME_CONFIG_ENV_KEYS,
  resetConfig,
  resetFrontendPortDeprecationWarning,
  TEST_MANAGED_CONFIG_DIR,
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
  'ALLOW_DIRECT_LOOPBACK',
  'MANGO_SECRET_STORE_UNSAFE_FILE_FALLBACK_DIR',
  'MANGO_LIBRARY_BACKUP_DIR',
  'MANGO_LIBRARY_BACKUP_RETENTION_COUNT',
  'MANGO_LIBRARY_BACKUP_RETENTION_BYTES',
  'MANGO_ENV_LTS_REFRESH',
  'MANGO_ENV_INSTALLS_ENABLED',
  'MANGO_CONTAINER',
  'FRONTEND_PORT',
  'ALLOWED_ORIGINS',
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

  test('ignores comments and malformed .env lines while applying valid overrides', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 4242\n');
    writeFileSync(join(TMP_DIR, '.env'), '# comment\nMALFORMED\n=value\nAPI_PORT=5555\n');

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.server.port).toBe(5555);
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

  // Defaults on: turning it off refuses a request a proxy forwarded without
  // X-Forwarded-For, which is a hardening an operator opts into rather than one
  // an upgrade hands them.
  test('security.allowDirectLoopback defaults to true', () => {
    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.security.allowDirectLoopback).toBe(true);
  });

  test('loads security.allowDirectLoopback from config.toml', () => {
    writeFileSync(TMP_TOML, '[security]\ntrustProxy = true\nallowDirectLoopback = false\n');

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.security.allowDirectLoopback).toBe(false);
  });

  test('process.env ALLOW_DIRECT_LOOPBACK overrides config.toml', () => {
    writeFileSync(TMP_TOML, '[security]\nallowDirectLoopback = false\n');
    process.env.ALLOW_DIRECT_LOOPBACK = 'true';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.security.allowDirectLoopback).toBe(true);
  });

  test('keeps live Node LTS refresh opt-in and lets env override TOML', () => {
    writeFileSync(TMP_TOML, '[environments]\nlts_refresh = true\n');
    process.env.MANGO_ENV_LTS_REFRESH = 'false';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.environments.ltsRefresh).toBe(false);
  });

  test('keeps environment installs disabled by default and lets env override TOML', () => {
    const defaults = loadConfig(join(TMP_DIR, 'nonexistent.toml'));
    expect(defaults.environments.installsEnabled).toBe(false);

    resetConfig();
    writeFileSync(TMP_TOML, '[environments]\ninstalls_enabled = false\n');
    process.env.MANGO_ENV_INSTALLS_ENABLED = 'true';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.environments.installsEnabled).toBe(true);
  });

  test('exposes container detection and lets MANGO_CONTAINER force it on', () => {
    const defaults = loadConfig(join(TMP_DIR, 'nonexistent.toml'));
    expect(defaults.environments.container).toBe(existsSync('/.dockerenv'));

    resetConfig();
    process.env.MANGO_CONTAINER = '1';

    expect(loadConfig(TMP_TOML).environments.container).toBe(true);
  });

  // The `[cursor]` section went with the Node sidecar. A TOML key nothing reads
  // must not look like it still works, and an unknown section is ignored rather
  // than rejected — so this asserts the ignoring, not an error.
  test('ignores a leftover [cursor] section without failing to load', () => {
    writeFileSync(
      TMP_TOML,
      '[cursor]\nsidecar_script = "/tmp/custom-run-agent.mjs"\nnode_path = "/opt/node22/bin/node"\n'
    );

    const cfg = loadConfig(TMP_TOML);

    expect(cfg).not.toHaveProperty('cursor');
    expect(cfg.configFilePath).toBe(TMP_TOML);
  });

  test('loads unsafe secret-store fallback directory from config.toml', () => {
    writeFileSync(
      TMP_TOML,
      '[secret_store]\nunsafe_file_fallback_dir = "./tmp/test-secret-store"\n'
    );

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.secretStore.unsafeFileFallbackDir).toBe(
      resolve(import.meta.dir, '../../../../../tmp/test-secret-store')
    );
  });

  test('MANGO_SECRET_STORE_UNSAFE_FILE_FALLBACK_DIR overrides config.toml', () => {
    writeFileSync(TMP_TOML, '[secret_store]\nunsafe_file_fallback_dir = "/tmp/from-toml"\n');
    process.env.MANGO_SECRET_STORE_UNSAFE_FILE_FALLBACK_DIR = '/tmp/from-env';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.secretStore.unsafeFileFallbackDir).toBe('/tmp/from-env');
  });

  test('defaults library backup settings under ~/.mango', () => {
    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.library.backupDir).toBe(join(process.env.HOME ?? '', '.mango', 'library-backups'));
    expect(cfg.library.backupRetentionCount).toBe(10);
  });

  test('loads library backup settings from config.toml', () => {
    writeFileSync(
      TMP_TOML,
      '[library]\nbackup_dir = "/tmp/library-backups"\nbackup_retention_count = 7\nbackup_retention_bytes = 2048\n'
    );

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.library).toEqual({
      backupDir: '/tmp/library-backups',
      backupRetentionCount: 7,
      backupRetentionBytes: 2048,
    });
  });

  test('MANGO_LIBRARY backup env vars override config.toml', () => {
    writeFileSync(
      TMP_TOML,
      '[library]\nbackup_dir = "/tmp/from-toml"\nbackup_retention_count = 7\n'
    );
    process.env.MANGO_LIBRARY_BACKUP_DIR = '/tmp/from-env';
    process.env.MANGO_LIBRARY_BACKUP_RETENTION_COUNT = '3';
    process.env.MANGO_LIBRARY_BACKUP_RETENTION_BYTES = '4096';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.library).toEqual({
      backupDir: '/tmp/from-env',
      backupRetentionCount: 3,
      backupRetentionBytes: 4096,
    });
  });

  test('ignores invalid library backup retention overrides', () => {
    writeFileSync(TMP_TOML, '[library]\nbackup_retention_count = 7\n');
    process.env.MANGO_LIBRARY_BACKUP_RETENTION_COUNT = '0';
    process.env.MANGO_LIBRARY_BACKUP_RETENTION_BYTES = '-1';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.library.backupRetentionCount).toBe(7);
    expect(cfg.library.backupRetentionBytes).toBe(512 * 1024 * 1024);
  });

  test('keeps test library backups inside the managed test sandbox', () => {
    const cfg = loadConfigForTest();

    expect(cfg.library.backupDir).toBe(join(TEST_MANAGED_CONFIG_DIR, 'library-backups'));
  });

  test('test-runtime config fallback isolates writable directories from ~/.mango', () => {
    const cfg = loadConfig();

    expect(cfg.uploads.dir).toBe(join(TEST_MANAGED_CONFIG_DIR, 'uploads'));
    expect(cfg.images.dir).toBe(join(TEST_MANAGED_CONFIG_DIR, 'images'));
    expect(cfg.toolImages.dir).toBe(join(TEST_MANAGED_CONFIG_DIR, 'tool-images'));
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

describe('corsOrigins: the server origin plus configured allowed origins', () => {
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

  test('a configured allowed origin joins the defaults instead of replacing them', () => {
    writeFileSync(
      TMP_TOML,
      '[server]\nport = 3001\nallowedOrigins = ["https://studio.example.com"]\n'
    );

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.corsOrigins).toEqual([
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://0.0.0.0:3001',
      'https://studio.example.com',
    ]);
  });

  test('ALLOWED_ORIGINS takes a comma-separated list', () => {
    process.env.ALLOWED_ORIGINS = 'https://studio.example.com, http://192.168.1.10:4173';

    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.server.allowedOrigins).toEqual([
      'https://studio.example.com',
      'http://192.168.1.10:4173',
    ]);
    expect(cfg.corsOrigins).toContain('https://studio.example.com');
    expect(cfg.corsOrigins).toContain('http://192.168.1.10:4173');
    // The server's own origins survive, so a local browser session still works.
    expect(cfg.corsOrigins).toContain('http://localhost:3001');
  });

  test('ALLOWED_ORIGINS tolerates padding and a trailing comma', () => {
    process.env.ALLOWED_ORIGINS = '  https://studio.example.com ,, ';

    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.server.allowedOrigins).toEqual(['https://studio.example.com']);
  });

  test('ALLOWED_ORIGINS replaces the config.toml list rather than extending it', () => {
    writeFileSync(TMP_TOML, '[server]\nallowedOrigins = ["https://from-toml.example"]\n');
    process.env.ALLOWED_ORIGINS = 'https://from-env.example';

    const cfg = loadConfig(TMP_TOML);

    expect(cfg.corsOrigins).toContain('https://from-env.example');
    expect(cfg.corsOrigins).not.toContain('https://from-toml.example');
  });

  test('an allowed origin that repeats a default is not listed twice', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:3001';

    const cfg = loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(cfg.corsOrigins.filter((origin) => origin === 'http://localhost:3001')).toHaveLength(1);
  });

  test('ALLOWED_ORIGINS is forwarded to detached servers with the other config keys', () => {
    expect(RUNTIME_CONFIG_ENV_KEYS).toContain('ALLOWED_ORIGINS');
  });

  // Every gate compares the browser's Origin header by exact string, so an
  // entry that is merely close parses fine and then matches nothing. Rejecting
  // it at load is what turns a silent no-op into a startup failure.
  test.each([
    ['studio.example.com', 'is not a URL'],
    ['ftp://studio.example.com', 'must use http:// or https://'],
    ['https://studio.example.com/app', 'must be a bare scheme://host[:port] origin'],
    ['https://studio.example.com/', 'must be a bare scheme://host[:port] origin'],
    ['https://studio.example.com:443', 'must be a bare scheme://host[:port] origin'],
  ])('rejects the malformed allowed origin %p', (origin, expected) => {
    process.env.ALLOWED_ORIGINS = origin;

    expect(() => loadConfig(join(TMP_DIR, 'nonexistent.toml'))).toThrow(expected);
  });

  test('a malformed allowed origin fails as a CliError, not a plain Error', () => {
    process.env.ALLOWED_ORIGINS = 'studio.example.com';

    expect(() => loadConfig(join(TMP_DIR, 'nonexistent.toml'))).toThrow(CliError);
  });

  test('names the canonical form when an entry is close but not exact', () => {
    process.env.ALLOWED_ORIGINS = 'https://studio.example.com/';

    expect(() => loadConfig(join(TMP_DIR, 'nonexistent.toml'))).toThrow(
      'did you mean "https://studio.example.com"'
    );
  });

  test('a configured frontend port contributes no origin of its own', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 3001\n[frontend]\nport = 5173\n');

    const cfg = loadConfig(TMP_TOML);

    // The API serves the frontend, so the only origins are the server's own.
    expect(cfg.corsOrigins).toEqual([
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://0.0.0.0:3001',
    ]);
  });
});

describe('auth.url validation', () => {
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

  // Better Auth reads the scheme (the `__Secure-` cookie prefix) and the host
  // (origin checks) out of this value without ever validating it, so a value
  // that is not an absolute URL fails as a login that never establishes a
  // session rather than as anything the operator can read.
  test.each([
    ['api.example.com', 'is not a URL'],
    // Parses: protocol `localhost:`, empty hostname. The shape a bare host:port
    // takes, and the one that would otherwise pass silently.
    ['localhost:3001', 'must use http:// or https:// and name a host'],
    ['ftp://api.example.com', 'must use http:// or https:// and name a host'],
  ])('rejects the malformed auth.url %p', (url, expected) => {
    process.env.BETTER_AUTH_URL = url;

    expect(() => loadConfig(join(TMP_DIR, 'nonexistent.toml'))).toThrow(expected);
  });

  test('a malformed auth.url fails as a CliError, not a plain Error', () => {
    process.env.BETTER_AUTH_URL = 'api.example.com';

    expect(() => loadConfig(join(TMP_DIR, 'nonexistent.toml'))).toThrow(CliError);
  });

  // Unlike an allowed origin, this one is not required to be bare: Better Auth
  // appends its basePath to it, so a subpath deployment is legitimate.
  test('accepts a base URL carrying a path', () => {
    process.env.BETTER_AUTH_URL = 'https://example.com/mango';

    expect(loadConfig(join(TMP_DIR, 'nonexistent.toml')).auth.url).toBe(
      'https://example.com/mango'
    );
  });

  test('the derived default passes its own validation', () => {
    writeFileSync(TMP_TOML, '[server]\nhost = "0.0.0.0"\nport = 3001\n');

    expect(loadConfig(TMP_TOML).auth.url).toBe('http://localhost:3001');
  });
});

describe('frontend.port deprecation warning', () => {
  let savedEnv: Record<string, string | undefined>;
  let warnings: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    savedEnv = saveEnv();
    for (const k of WATCHED_ENV_KEYS) delete process.env[k];
    resetConfig();
    // The latch is process-wide, so another test file may already have tripped it.
    resetFrontendPortDeprecationWarning();
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    resetConfig();
    resetFrontendPortDeprecationWarning();
    restoreEnv(savedEnv);
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  function deprecationWarnings(): string[] {
    return warnings.filter((line) => line.includes('[frontend] settings are deprecated'));
  }

  test('warns once per process when config.toml sets frontend.port', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 3001\n[frontend]\nport = 5173\n');

    loadConfig(TMP_TOML);
    loadConfig(TMP_TOML);

    expect(deprecationWarnings()).toEqual([
      '[config] The [frontend] settings are deprecated and ignored; the frontend is served by ' +
        'the API on 3001. To allow a frontend served from another origin, set ' +
        'server.allowedOrigins (or ALLOWED_ORIGINS).',
    ]);
  });

  test('warns when config.toml sets only frontend.host', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 3001\n[frontend]\nhost = "myapp.example.com"\n');

    loadConfig(TMP_TOML);

    expect(deprecationWarnings()).toHaveLength(1);
  });

  test('warns when FRONTEND_PORT is set in the environment', () => {
    process.env.FRONTEND_PORT = '5173';

    loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(deprecationWarnings()).toHaveLength(1);
  });

  test('reports the resolved server port, not the deprecated one', () => {
    process.env.FRONTEND_PORT = '5173';
    process.env.API_PORT = '13077';

    loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(deprecationWarnings()[0]).toContain('served by the API on 13077.');
  });

  test('stays silent when neither source sets it', () => {
    writeFileSync(TMP_TOML, '[server]\nport = 3001\n');

    loadConfig(TMP_TOML);
    loadConfig(join(TMP_DIR, 'nonexistent.toml'));

    expect(deprecationWarnings()).toEqual([]);
  });
});
