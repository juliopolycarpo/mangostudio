import { describe, expect, it } from 'bun:test';
import {
  HUB_BINDING_KEY_CAPABILITY,
  HUB_BINDING_KEY_MAX_LENGTH,
  hubBindingKeyOf,
} from '@mangostudio/shared/runtime-contract';

describe('hubBindingKeyOf', () => {
  it('reads a bounded, non-empty string key', () => {
    expect(hubBindingKeyOf({ [HUB_BINDING_KEY_CAPABILITY]: 'record-a' })).toBe('record-a');
    const longest = 'k'.repeat(HUB_BINDING_KEY_MAX_LENGTH);
    expect(hubBindingKeyOf({ [HUB_BINDING_KEY_CAPABILITY]: longest })).toBe(longest);
  });

  it.each([
    ['absent', {}],
    ['empty', { [HUB_BINDING_KEY_CAPABILITY]: '' }],
    ['not a string', { [HUB_BINDING_KEY_CAPABILITY]: 7 }],
    ['too long', { [HUB_BINDING_KEY_CAPABILITY]: 'k'.repeat(HUB_BINDING_KEY_MAX_LENGTH + 1) }],
  ])('treats a %s key as no key', (_why, capabilities) => {
    expect(hubBindingKeyOf(capabilities)).toBeUndefined();
  });
});
