import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { DEFAULT_PROFILE_ID, ProfileIdSchema } from '../../src/profiles';

describe('ProfileIdSchema', () => {
  it.each(['default', 'work-laptop'])('accepts %s', (value) => {
    expect(Value.Check(ProfileIdSchema, value)).toBe(true);
  });

  it.each(['Work', 'a/b', '', `${'a'.repeat(65)}`])('rejects %s', (value) => {
    expect(Value.Check(ProfileIdSchema, value)).toBe(false);
  });

  it('accepts DEFAULT_PROFILE_ID', () => {
    expect(Value.Check(ProfileIdSchema, DEFAULT_PROFILE_ID)).toBe(true);
    expect(DEFAULT_PROFILE_ID).toBe('default');
  });
});
