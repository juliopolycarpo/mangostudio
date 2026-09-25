import { describe, expect, it } from 'bun:test';
import { HUB_BINDING_KEY_LENGTH, HubBindingKeySchema } from '@mangostudio/shared/runtime-contract';
import Value from 'typebox/value';

describe('HubBindingKeySchema', () => {
  it('accepts a lowercase hex digest of the fixed length', () => {
    expect(Value.Check(HubBindingKeySchema, 'a'.repeat(HUB_BINDING_KEY_LENGTH))).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['one short', 'a'.repeat(HUB_BINDING_KEY_LENGTH - 1)],
    ['one long', 'a'.repeat(HUB_BINDING_KEY_LENGTH + 1)],
    ['uppercase', 'A'.repeat(HUB_BINDING_KEY_LENGTH)],
    ['not hex', 'g'.repeat(HUB_BINDING_KEY_LENGTH)],
  ])('refuses a %s key', (_why, key) => {
    expect(Value.Check(HubBindingKeySchema, key)).toBe(false);
  });
});
