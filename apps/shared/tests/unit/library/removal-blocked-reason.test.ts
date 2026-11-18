import { describe, expect, it } from 'bun:test';

import Value from 'typebox/value';

import { RemovalBlockedReasonSchema, RemovalLocationSchema } from '../../../src/library';

describe('RemovalBlockedReasonSchema', () => {
  it('accepts location-disabled, the reason for a location the user switched off', () => {
    expect(
      Value.Check(RemovalBlockedReasonSchema, 'location-disabled'),
      'expected "location-disabled" to be a removal blocked reason | received: rejected'
    ).toBe(true);
  });

  it('rejects a code outside the catalog', () => {
    expect(Value.Check(RemovalBlockedReasonSchema, 'location-turned-off')).toBe(false);
  });

  it('lets a removal row carry location-disabled as a blocked operation', () => {
    const row = {
      environmentId: 'local',
      locationId: 'claude-skills',
      targetIds: ['claude'],
      operation: 'blocked',
      blockedReason: 'location-disabled',
      path: null,
      eliminatesContentGroup: false,
    };

    expect(
      Value.Check(RemovalLocationSchema, row),
      `expected a blocked row to match RemovalLocationSchema | received: ${JSON.stringify([...Value.Errors(RemovalLocationSchema, row)])}`
    ).toBe(true);
  });
});
