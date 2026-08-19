import { afterEach, describe, expect, it } from 'bun:test';
import {
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  type LibraryLocationSettings,
} from '@mangostudio/shared/app-settings';
import type { AgentCliStatus } from '@mangostudio/shared/environments';
import { getDb } from '../../../../src/db/database';
import { migrateLibraryLocationSettings } from '../../../../src/db/migrations/030_library_location_settings';
import { migrateProfileScopedAppSettings } from '../../../../src/db/migrations/033_profile_scoped_app_settings';
import { migrateScopedLibraryLocationSettings } from '../../../../src/db/migrations/034_scoped_library_location_settings';
import {
  defaultsForDetectedAgents,
  getAppSettings,
  setLibraryLocationDefaultsForTest,
} from '../../../../src/modules/app-settings/application/app-settings-service';
import { environmentProbingService } from '../../../../src/modules/environments/application/probing-service';

function detected(targetId: AgentCliStatus['targetId']): AgentCliStatus {
  return { targetId, effective: { path: '/bin/tool' } } as AgentCliStatus;
}

const originalNodeEnv = process.env.NODE_ENV;
const originalListAgentCliStatuses = environmentProbingService.listAgentCliStatuses;

afterEach(() => {
  setLibraryLocationDefaultsForTest(DEFAULT_LIBRARY_LOCATION_SETTINGS);
  environmentProbingService.listAgentCliStatuses = originalListAgentCliStatuses;
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe('library location settings', () => {
  it('uses deterministic defaults regardless of NODE_ENV', async () => {
    environmentProbingService.listAgentCliStatuses = () => Promise.resolve([detected('codex')]);

    const defaults: LibraryLocationSettings[] = [];
    for (const nodeEnv of ['test', 'development', undefined]) {
      if (nodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = nodeEnv;
      }
      const settings = await getAppSettings(getDb(), `node-env-${nodeEnv ?? 'unset'}`);
      defaults.push(settings.profileSettings.default.libraryLocations);
    }

    expect(defaults).toEqual([
      DEFAULT_LIBRARY_LOCATION_SETTINGS,
      DEFAULT_LIBRARY_LOCATION_SETTINGS,
      DEFAULT_LIBRARY_LOCATION_SETTINGS,
    ]);
  });

  it('can opt into detection-derived defaults through the test seam', async () => {
    const detectedDefaults = defaultsForDetectedAgents([detected('codex')]);
    environmentProbingService.listAgentCliStatuses = () => Promise.resolve([detected('codex')]);
    setLibraryLocationDefaultsForTest(null);
    delete process.env.NODE_ENV;

    const settings = await getAppSettings(getDb(), 'detection-derived-defaults');

    expect(settings.profileSettings.default.libraryLocations).toEqual(detectedDefaults);
  });

  it('defaults vendor locations from detected CLIs and keeps MangoStudio native locations on', () => {
    const defaults = defaultsForDetectedAgents([detected('codex')]);

    expect(defaults.home['mango-skills']).toBe(true);
    expect(defaults.home['mango-agents']).toBe(true);
    expect(defaults.home['agents-skills']).toBe(true);
    expect(defaults.home['codex-skills']).toBe(true);
    expect(defaults.home['claude-skills']).toBe(false);
    expect(defaults.home['cursor-skills']).toBe(false);
  });

  it('buckets defaults by scope and leaves the reserved workspace scope empty', () => {
    const defaults = defaultsForDetectedAgents([detected('codex')]);

    expect(defaults.workspace).toEqual({});
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

describe('migrateScopedLibraryLocationSettings', () => {
  const nested = (locations: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ profileSettings: { default: { libraryLocations: locations } }, ...extra });

  it('moves the flat toggles under the home scope and reserves workspace on up', () => {
    const original = nested(
      { 'mango-skills': true, 'agents-skills': true, 'claude-skills': false },
      { thinkingEnabled: true }
    );
    const migrated = migrateScopedLibraryLocationSettings(original, 'up');
    const parsed = JSON.parse(migrated);

    expect(parsed.profileSettings.default.libraryLocations).toEqual({
      home: { 'mango-skills': true, 'agents-skills': true, 'claude-skills': false },
      workspace: {},
    });
    expect(parsed.thinkingEnabled).toBe(true);
    expect(migrateScopedLibraryLocationSettings(migrated, 'up')).toBe(migrated);
  });

  it('preserves sibling profile keys and other profiles', () => {
    const original = JSON.stringify({
      profileSettings: {
        default: { libraryLocations: { 'cursor-skills': true }, futureKey: 'kept' },
        other: { libraryLocations: { 'claude-skills': true } },
      },
    });
    const parsed = JSON.parse(migrateScopedLibraryLocationSettings(original, 'up'));

    expect(parsed.profileSettings.default.futureKey).toBe('kept');
    expect(parsed.profileSettings.other).toEqual({
      libraryLocations: { 'claude-skills': true },
    });
  });

  it('unnests back to the home toggles on down', () => {
    const migrated = nested({ home: { 'agents-skills': true }, workspace: {} });
    const parsed = JSON.parse(migrateScopedLibraryLocationSettings(migrated, 'down'));

    expect(parsed.profileSettings.default.libraryLocations).toEqual({ 'agents-skills': true });
  });

  it('round-trips flat toggles through up then down', () => {
    const original = nested({ 'cursor-skills': true }, { futureSetting: { retained: true } });
    const up = migrateScopedLibraryLocationSettings(original, 'up');
    const parsed = JSON.parse(migrateScopedLibraryLocationSettings(up, 'down'));

    expect(parsed.profileSettings.default.libraryLocations).toEqual({ 'cursor-skills': true });
    expect(parsed.futureSetting).toEqual({ retained: true });
  });

  it('is a no-op when there is nothing nested to move', () => {
    const flatOnly = JSON.stringify({ libraryLocations: { 'agents-skills': true } });
    expect(migrateScopedLibraryLocationSettings(flatOnly, 'up')).toBe(flatOnly);

    const alreadyFlat = nested({ 'agents-skills': true });
    expect(migrateScopedLibraryLocationSettings(alreadyFlat, 'down')).toBe(alreadyFlat);
  });

  it('leaves non-object JSON unchanged', () => {
    expect(migrateScopedLibraryLocationSettings('"string"', 'up')).toBe('"string"');
    expect(migrateScopedLibraryLocationSettings('[]', 'down')).toBe('[]');
    expect(migrateScopedLibraryLocationSettings('{', 'up')).toBe('{');
  });
});
