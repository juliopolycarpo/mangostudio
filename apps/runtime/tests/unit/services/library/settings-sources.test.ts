/**
 * Settings sources are read on the machine that owns them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { readSettingsSources } from '../../../../src/services/library';

let home: string;

const envFor = (homeDir: string): PathEnv => ({
  platform: process.platform,
  homeDir,
  env: {},
});

const sourceFor = (homeDir: string, locationId: string) =>
  readSettingsSources(envFor(homeDir)).sources.find((source) => source.locationId === locationId);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mango-runtime-settings-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('readSettingsSources', () => {
  it('reports the machine home and a source for every settings location', () => {
    const result = readSettingsSources(envFor(home));
    expect(result.homeDir).toBe(home);
    expect(result.sources.length).toBeGreaterThan(0);
    // One entry per location, never two.
    const ids = result.sources.map((source) => source.locationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports a missing settings file as absent rather than failed', () => {
    const source = sourceFor(home, 'claude-settings');
    expect(source?.present).toBe(false);
    expect(source?.failureReason).toBeUndefined();
  });

  it('returns the raw bytes of a settings file it can read', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const content = '{"model":"opus"}';
    writeFileSync(join(home, '.claude', 'settings.json'), content);

    const source = sourceFor(home, 'claude-settings');
    expect(source?.present).toBe(true);
    expect(source?.content).toBe(content);
    expect(source?.sizeBytes).toBe(Buffer.byteLength(content));
  });

  it('gives two locations backed by one file the same read', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const content = '{"hooks":{}}';
    writeFileSync(join(home, '.claude', 'settings.json'), content);

    const result = readSettingsSources(envFor(home));
    const settings = result.sources.find((source) => source.locationId === 'claude-settings');
    const hooks = result.sources.find((source) => source.locationId === 'claude-hooks');
    expect(settings?.content).toBe(content);
    expect(hooks?.content).toBe(content);
    expect(hooks?.sizeBytes).toBe(settings?.sizeBytes);
  });

  // A settings path is a fixed, vendor-defined name. Whatever a symlink there
  // points at is not the file the user was asked about.
  it('refuses a settings path that is a symlink', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const elsewhere = join(home, 'planted.json');
    writeFileSync(elsewhere, '{"stolen":true}');
    symlinkSync(elsewhere, join(home, '.claude', 'settings.json'));

    const source = sourceFor(home, 'claude-settings');
    expect(source?.failureReason).toBe('not-regular-file');
    expect(source?.content).toBeUndefined();
  });

  it('never reads a target credential file while reading every settings source', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    const secret = '{"token":"do-not-read-me"}';
    writeFileSync(join(home, '.claude', '.credentials.json'), secret);
    writeFileSync(join(home, '.codex', 'auth.json'), secret);

    const contents = readSettingsSources(envFor(home))
      .sources.map((source) => source.content)
      .filter((content): content is string => content !== undefined);
    expect(contents.some((content) => content.includes('do-not-read-me'))).toBe(false);
  });
});
