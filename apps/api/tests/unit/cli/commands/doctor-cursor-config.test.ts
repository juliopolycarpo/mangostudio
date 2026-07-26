import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCursorConnectorConfigured } from '../../../../src/cli/commands/doctor';
import type { MangoConfig } from '../../../../src/lib/config';

const TMP_DIR = join('/tmp', `mango-doctor-cursor-config-${process.pid}`);

function makeConfig(configFilePath: string): MangoConfig {
  return {
    server: { host: 'localhost', port: 3001 },
    frontend: { host: 'localhost', port: 5173 },
    database: { path: ':memory:' },
    uploads: { dir: '/data/uploads' },
    images: { dir: '/data/images' },
    agents: { dir: '/data/agents' },
    skills: { dir: '/data/skills' },
    library: { backupDir: '/data/library-backups', backupRetentionCount: 10 },
    checkpoints: { dir: '/data/checkpoints' },
    auth: { secret: 'x'.repeat(32), url: 'http://localhost:3001' },
    security: { trustProxy: false },
    cursor: { workspaceDir: '', sidecarScriptPath: '', nodePath: '' },
    chatgpt: { authBaseUrl: 'https://auth.openai.com', apiBaseUrl: 'https://api.openai.com' },
    secretStore: { unsafeFileFallbackDir: '' },
    corsOrigins: [],
    configFilePath,
  };
}

describe('isCursorConnectorConfigured', () => {
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    for (const key of Object.keys(process.env)) {
      if (key === 'CURSOR_API_KEY' || key.startsWith('CURSOR_API_KEY_')) {
        envSnapshot[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (key === 'CURSOR_API_KEY' || key.startsWith('CURSOR_API_KEY_')) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('detects named Cursor env connectors in process.env', () => {
    process.env.CURSOR_API_KEY_WORK = 'cursor-secret';
    const configPath = join(TMP_DIR, 'config.toml');
    writeFileSync(configPath, '[server]\nhost = "localhost"\n');

    expect(isCursorConnectorConfigured(makeConfig(configPath))).toBe(true);
  });

  it('detects Cursor keys from the paired .env file without reloadSecretEnv', () => {
    const configPath = join(TMP_DIR, 'config.toml');
    writeFileSync(configPath, '[server]\nhost = "localhost"\n');
    writeFileSync(join(TMP_DIR, '.env'), 'CURSOR_API_KEY_DEFAULT="cursor-secret"\n');

    expect(isCursorConnectorConfigured(makeConfig(configPath))).toBe(true);
  });

  it('detects Cursor keys from config.toml', () => {
    const configPath = join(TMP_DIR, 'config.toml');
    writeFileSync(configPath, '[cursor_api_keys]\ndefault = "cursor-secret"\n');

    expect(isCursorConnectorConfigured(makeConfig(configPath))).toBe(true);
  });

  it('returns false when no Cursor secret is configured', () => {
    const configPath = join(TMP_DIR, 'config.toml');
    writeFileSync(configPath, '[server]\nhost = "localhost"\n');
    writeFileSync(join(TMP_DIR, '.env'), 'CURSOR_API_KEY_DEFAULT=""\n');

    expect(isCursorConnectorConfigured(makeConfig(configPath))).toBe(false);
  });
});
