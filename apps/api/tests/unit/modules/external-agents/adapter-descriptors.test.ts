import { describe, expect, it } from 'bun:test';
import {
  EXTERNAL_AGENT_TARGET_IDS,
  EXTERNAL_PERMISSION_LEVELS,
} from '@mangostudio/shared/external-agents';

import {
  EXTERNAL_AGENT_PRODUCT_DESCRIPTORS,
  EXTERNAL_PERMISSION_LEVEL_COPY_KEYS,
  productDescriptorFor,
} from '../../../../src/modules/external-agents/domain/adapter-descriptors';

describe('external agent product descriptors', () => {
  it('covers every hosted target exactly once', () => {
    const declared = EXTERNAL_AGENT_PRODUCT_DESCRIPTORS.map((descriptor) => descriptor.targetId);

    expect([...declared].sort()).toEqual([...EXTERNAL_AGENT_TARGET_IDS].sort());
    expect(new Set(declared).size).toBe(declared.length);
    for (const targetId of EXTERNAL_AGENT_TARGET_IDS) {
      expect(productDescriptorFor(targetId)).toBeDefined();
    }
  });

  it('orders the selector the way the adapters are being built', () => {
    expect(EXTERNAL_AGENT_PRODUCT_DESCRIPTORS.map((descriptor) => descriptor.targetId)).toEqual([
      'codex',
      'cursor',
      'claude',
    ]);
  });

  it('carries the sign-in command each CLI actually accepts', () => {
    expect(productDescriptorFor('codex')?.loginCommand).toBe('codex login');
    expect(productDescriptorFor('cursor')?.loginCommand).toBe('cursor-agent login');
    expect(productDescriptorFor('claude')?.loginCommand).toBe('claude auth login');
  });

  it('names the label each target already has rather than inventing a second one', () => {
    for (const descriptor of EXTERNAL_AGENT_PRODUCT_DESCRIPTORS) {
      expect(descriptor.displayNameKey).toBe(`library.targets.${descriptor.targetId}`);
    }
  });

  it('has copy for every permission level', () => {
    // The dictionaries themselves are held to this by the i18n parity suite,
    // which is where a locale can be read without importing it into the hub.
    for (const level of EXTERNAL_PERMISSION_LEVELS) {
      expect(EXTERNAL_PERMISSION_LEVEL_COPY_KEYS[level]).toBe(
        `externalAgents.permission.level.${level}`
      );
    }
  });
});
