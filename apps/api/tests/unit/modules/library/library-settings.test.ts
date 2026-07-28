import { describe, expect, it } from 'bun:test';
import type { AgentCliStatus } from '@mangostudio/shared/environments';
import { migrateLibraryLocationSettings } from '../../../../src/db/migrations/030_library_location_settings';
import { migrateProfileScopedAppSettings } from '../../../../src/db/migrations/033_profile_scoped_app_settings';
import { defaultsForDetectedAgents } from '../../../../src/modules/app-settings/application/app-settings-service';

function detected(targetId: AgentCliStatus['targetId']): AgentCliStatus {
  return { targetId, effective: { path: '/bin/tool' } } as AgentCliStatus;
}

describe('library location settings', () => {
  it('defaults vendor locations from detected CLIs and keeps MangoStudio native locations on', () => {
    const defaults = defaultsForDetectedAgents([detected('codex')]);

    expect(defaults['mango-skills']).toBe(true);
    expect(defaults['mango-agents']).toBe(true);
    expect(defaults['agents-skills']).toBe(true);
    expect(defaults['codex-skills']).toBe(true);
    expect(defaults['claude-skills']).toBe(false);
    expect(defaults['cursor-skills']).toBe(false);
  });

  it('migrates legacy source booleans without dropping unknown keys', () => {
    const original = JSON.stringify({
      skillSources: { agents: false, claude: true },
      futureSetting: { retained: true },
    });
    const migrated = migrateLibraryLocationSettings(original, 'up');
    const parsed = JSON.parse(migrated);

    expect(parsed.libraryLocations).toMatchObject({
      'mango-skills': true,
      'agents-skills': false,
      'claude-skills': true,
    });
    expect(parsed.futureSetting).toEqual({ retained: true });
    expect(migrateLibraryLocationSettings(migrated, 'up')).toBe(migrated);
  });

  it('restores legacy booleans on downgrade while retaining the location map', () => {
    const migrated = JSON.stringify({
      libraryLocations: {
        'mango-skills': true,
        'agents-skills': true,
        'claude-skills': false,
        'cursor-skills': true,
      },
    });
    const parsed = JSON.parse(migrateLibraryLocationSettings(migrated, 'down'));

    expect(parsed.skillSources).toEqual({ agents: true, claude: false });
    expect(parsed.libraryLocations['cursor-skills']).toBe(true);
  });
});

describe('migrateProfileScopedAppSettings', () => {
  it('nests flat libraryLocations under profileSettings.default on up', () => {
    const original = JSON.stringify({
      libraryLocations: {
        'mango-skills': true,
        'agents-skills': true,
        'claude-skills': false,
      },
      thinkingEnabled: true,
    });
    const migrated = migrateProfileScopedAppSettings(original, 'up');
    const parsed = JSON.parse(migrated);

    expect(parsed.profileSettings).toEqual({
      default: {
        libraryLocations: {
          'mango-skills': true,
          'agents-skills': true,
          'claude-skills': false,
        },
      },
    });
    // Additive: the flat key stays so a downgrade still sees the pre-nesting shape.
    expect(parsed.libraryLocations).toEqual({
      'mango-skills': true,
      'agents-skills': true,
      'claude-skills': false,
    });
    expect(parsed.thinkingEnabled).toBe(true);
    expect(migrateProfileScopedAppSettings(migrated, 'up')).toBe(migrated);
  });

  it('prefers an existing nested map over the flat key on up', () => {
    const original = JSON.stringify({
      libraryLocations: { 'agents-skills': false },
      profileSettings: {
        default: {
          libraryLocations: { 'agents-skills': true, 'claude-skills': true },
        },
      },
    });
    const migrated = migrateProfileScopedAppSettings(original, 'up');
    const parsed = JSON.parse(migrated);

    expect(parsed.profileSettings.default.libraryLocations).toEqual({
      'agents-skills': true,
      'claude-skills': true,
    });
  });

  it('removes profileSettings on down while leaving other keys intact', () => {
    const nested = JSON.stringify({
      libraryLocations: {
        'mango-skills': true,
        'agents-skills': true,
      },
      profileSettings: {
        default: {
          libraryLocations: {
            'mango-skills': true,
            'agents-skills': true,
          },
        },
      },
      thinkingEnabled: false,
    });
    const downgraded = migrateProfileScopedAppSettings(nested, 'down');
    const parsed = JSON.parse(downgraded);

    expect(parsed.profileSettings).toBeUndefined();
    expect(parsed.libraryLocations).toEqual({
      'mango-skills': true,
      'agents-skills': true,
    });
    expect(parsed.thinkingEnabled).toBe(false);
  });

  it('round-trips flat settings through up then down', () => {
    const original = JSON.stringify({
      libraryLocations: { 'cursor-skills': true },
      futureSetting: { retained: true },
    });
    const up = migrateProfileScopedAppSettings(original, 'up');
    const down = migrateProfileScopedAppSettings(up, 'down');
    const parsed = JSON.parse(down);

    expect(parsed.profileSettings).toBeUndefined();
    expect(parsed.libraryLocations).toEqual({ 'cursor-skills': true });
    expect(parsed.futureSetting).toEqual({ retained: true });
  });

  it('leaves non-object JSON unchanged', () => {
    expect(migrateProfileScopedAppSettings('"string"', 'up')).toBe('"string"');
    expect(migrateProfileScopedAppSettings('[]', 'down')).toBe('[]');
    expect(migrateProfileScopedAppSettings('{', 'up')).toBe('{');
  });
});
