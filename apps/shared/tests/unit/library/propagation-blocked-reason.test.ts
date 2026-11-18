import { describe, expect, it } from 'bun:test';

import Value from 'typebox/value';

import { PropagationBlockedReasonSchema, PropagationDestinationSchema } from '../../../src/library';

describe('PropagationBlockedReasonSchema', () => {
  it('accepts location-disabled, the reason for a location the user switched off', () => {
    expect(
      Value.Check(PropagationBlockedReasonSchema, 'location-disabled'),
      'expected "location-disabled" to be a propagation blocked reason | received: rejected'
    ).toBe(true);
  });

  it('rejects a code outside the catalog', () => {
    expect(Value.Check(PropagationBlockedReasonSchema, 'location-turned-off')).toBe(false);
  });

  it('lets a destination carry location-disabled with no outcomes', () => {
    const destination = {
      environmentId: 'local',
      locationId: 'cursor-skills',
      targetIds: ['cursor'],
      toFormat: 'markdown-frontmatter',
      path: '/home/dev/.cursor/skills',
      blockedReason: 'location-disabled',
      outcomes: [],
    };

    expect(
      Value.Check(PropagationDestinationSchema, destination),
      `expected a blocked destination to match PropagationDestinationSchema | received: ${JSON.stringify([...Value.Errors(PropagationDestinationSchema, destination)])}`
    ).toBe(true);
  });
});
