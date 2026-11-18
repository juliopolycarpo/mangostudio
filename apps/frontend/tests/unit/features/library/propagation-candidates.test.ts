/**
 * Candidate destinations for a preview are every location of the kind. The API
 * reports a disabled or unsupported one as a blocked destination, and the wizard
 * can only explain a location that is present in the preview.
 */

import { describe, expect, it } from 'bun:test';

import { propagationCandidateLocationIds } from '../../../../src/features/library/format';
import { location } from './fixtures';

describe('propagationCandidateLocationIds', () => {
  const locations = [
    location({ id: 'mango-skills', path: '/home/dev/.mango/skills' }),
    location({ id: 'agents-skills', path: '/home/dev/.agents/skills' }),
    location({ id: 'cursor-skills', path: '/home/dev/.cursor/skills' }),
    location({ id: 'codex-skills', path: null }),
    location({ id: 'mango-agents', kind: 'subagent', path: '/home/dev/.mango/agents' }),
  ];

  it('keeps every location of the requested kind, including ones with no path here', () => {
    // `cursor-skills` may be disabled in settings and `codex-skills` has no path
    // on this platform; both stay so the preview can say why they are blocked.
    expect(propagationCandidateLocationIds(locations, 'skill')).toEqual([
      'mango-skills',
      'agents-skills',
      'cursor-skills',
      'codex-skills',
    ]);
  });

  it('drops locations of another kind', () => {
    expect(propagationCandidateLocationIds(locations, 'subagent')).toEqual(['mango-agents']);
  });
});
