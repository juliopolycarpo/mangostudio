import { describe, expect, it } from 'bun:test';
import type { AgentCliStatus } from '@mangostudio/shared/environments';
import { migrateLibraryLocationSettings } from '../../../../src/db/migrations/030_library_location_settings';
import { defaultsForDetectedAgents } from '../../../../src/modules/app-settings/application/app-settings-service';

function detected(targetId: AgentCliStatus['targetId']): AgentCliStatus {
  return { targetId, effective: { path: '/bin/tool' } } as AgentCliStatus;
}

describe('library location settings', () => {
  it('defaults vendor locations from detected CLIs and keeps MangoStudio native locations on', () => {
    const defaults = defaultsForDetectedAgents([detected('codex')]);

    expect(defaults['mango-skills']).toBe(true);
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
