/**
 * Regression tests for configuration loading precedence.
 *
 * Verifies the four-tier hierarchy documented in config.ts:
 *   1. process.env   (highest priority)
 *   2. .mango/.env   (file overrides)
 *   3. config.toml
 *   4. Hardcoded defaults
 *
 * Uses temporary TOML files in /tmp so the tests do not depend on the
 * presence of .mango/config.toml in the developer's environment.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { loadConfig, resetConfig } from '../../../src/lib/config';

const TMP_DIR = join('/tmp', `mango-config-test-${process.pid}`);
const TMP_TOML = join(TMP_DIR, 'config.toml');

const WATCHED_ENV_KEYS = ['API_PORT', 'API_HOST', 'DATABASE_PATH', 'UPLOADS_DIR'];

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
    WATCHED_ENV_KEYS.forEach((k) => delete process.env[k]);
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
});
