/**
 * Candidate destinations for a preview must match what the scanner will touch.
 * Naming a disabled location produces the 422 the wizard used to walk into.
 */

import { describe, expect, it } from 'bun:test';
import { enabledLibraryLocations } from '@mangostudio/shared/library';
import { propagationCandidateLocationIds } from '../../../../src/features/library/format';
import { location } from './fixtures';

describe('propagationCandidateLocationIds', () => {
  const locations = [
    location({ id: 'mango-skills', path: '/home/dev/.mango/skills' }),
    location({ id: 'agents-skills', path: '/home/dev/.agents/skills' }),
    location({ id: 'claude-skills', path: '/home/dev/.claude/skills' }),
    location({ id: 'cursor-skills', path: '/home/dev/.cursor/skills' }),
    location({ id: 'codex-skills', path: null }),
    location({ id: 'mango-agents', kind: 'subagent', path: '/home/dev/.mango/agents' }),
  ];

  it('keeps only enabled locations of the requested kind that resolve on this platform', () => {
    // `codex-skills` is enabled and still dropped: it has no path here.
    const enabled = new Set(['mango-skills', 'agents-skills', 'codex-skills', 'mango-agents']);

    expect(propagationCandidateLocationIds(locations, 'skill', enabled)).toEqual([
      'mango-skills',
      'agents-skills',
    ]);
  });

  it('drops locations that exist on disk but are disabled in settings', () => {
    const enabled = new Set(['mango-skills']);

    expect(propagationCandidateLocationIds(locations, 'skill', enabled)).toEqual(['mango-skills']);
  });

  it('honours the always-enabled locations the settings record cannot switch off', () => {
    // Every toggle is off, yet MangoStudio's own directories stay scannable, so
    // they stay offerable too.
    const enabled = enabledLibraryLocations(
      {
        home: {
          'mango-skills': false,
          'agents-skills': false,
          'claude-skills': false,
        },
        workspace: {},
      },
      'home'
    );

    expect(propagationCandidateLocationIds(locations, 'skill', enabled)).toEqual(['mango-skills']);
  });
});
