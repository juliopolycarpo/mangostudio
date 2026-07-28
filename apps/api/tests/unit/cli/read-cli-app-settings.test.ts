import { Database as SQLiteDatabase } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_APP_SETTINGS,
  libraryLocationsFor,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import { readCliAppSettings } from '../../../src/cli/read-cli-app-settings';
import type { MangoConfig } from '../../../src/lib/config';

function makeConfig(dbPath: string): MangoConfig {
  return {
    server: { host: 'localhost', port: 3001 },
    frontend: { host: 'localhost', port: 5173 },
    database: { path: dbPath },
    uploads: { dir: '/data/uploads' },
    images: { dir: '/data/images' },
    agents: { dir: '/data/agents' },
    skills: { dir: '/data/skills' },
    library: {
      backupDir: '/data/library-backups',
      backupRetentionCount: 10,
      backupRetentionBytes: 1024,
    },
    checkpoints: { dir: '/data/checkpoints' },
    auth: { secret: 'x'.repeat(32), url: 'http://localhost:3001' },
    security: { trustProxy: false },
    environments: { ltsRefresh: false, installsEnabled: false, container: false },
    cursor: { workspaceDir: '', sidecarScriptPath: '', nodePath: '' },
    chatgpt: { authBaseUrl: 'https://auth.openai.com', apiBaseUrl: 'https://api.openai.com' },
    secretStore: { unsafeFileFallbackDir: '' },
    corsOrigins: [],
    configFilePath: '/data/config.toml',
  };
}

describe('readCliAppSettings', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when the database is missing', () => {
    const settings = readCliAppSettings(makeConfig('/no/such/db.sqlite'));
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('reads persisted libraryLocations from SQLite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-app-settings-'));
    dirs.push(dir);
    const dbPath = join(dir, 'db.sqlite');
    const persisted = withLibraryLocations(DEFAULT_APP_SETTINGS, 'default', {
      'mango-skills': true,
      'agents-skills': true,
      'claude-skills': true,
    });

    const db = new SQLiteDatabase(dbPath);
    db.run(
      `CREATE TABLE user_app_settings (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        settingsJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )`
    );
    db.run(
      'INSERT INTO user_app_settings (id, userId, settingsJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
      ['row-1', 'user-1', JSON.stringify(persisted), Date.now(), Date.now()]
    );
    db.close();

    const settings = readCliAppSettings(makeConfig(dbPath));
    const locations = libraryLocationsFor(settings);
    expect(locations['agents-skills']).toBe(true);
    expect(locations['claude-skills']).toBe(true);
  });

  it('selects the most recently updated settings row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-app-settings-'));
    dirs.push(dir);
    const dbPath = join(dir, 'db.sqlite');
    const older = withLibraryLocations(DEFAULT_APP_SETTINGS, 'default', {
      'mango-skills': true,
      'agents-skills': false,
    });
    const newer = withLibraryLocations(DEFAULT_APP_SETTINGS, 'default', {
      'mango-skills': true,
      'agents-skills': true,
    });

    const db = new SQLiteDatabase(dbPath);
    db.run(
      `CREATE TABLE user_app_settings (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        settingsJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )`
    );
    db.run(
      'INSERT INTO user_app_settings (id, userId, settingsJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
      ['old', 'user-old', JSON.stringify(older), 1, 10]
    );
    db.run(
      'INSERT INTO user_app_settings (id, userId, settingsJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
      ['new', 'user-new', JSON.stringify(newer), 2, 20]
    );
    db.close();

    const locations = libraryLocationsFor(readCliAppSettings(makeConfig(dbPath)));
    expect(locations['agents-skills']).toBe(true);
  });
});
