import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProviderType } from '@mangostudio/shared/types';
import {
  clearRegistry,
  listRegisteredProviderTypes,
} from '../../../../src/services/providers/core/provider-registry';
import { registerProviders } from '../../../../src/services/providers/register-providers';

const EXPECTED_PROVIDER_TYPES = [
  'anthropic',
  'deepseek',
  'gemini',
  'openai',
  'openai-compatible',
] as const satisfies readonly ProviderType[];

function sortedRegisteredProviderTypes(): ProviderType[] {
  return [...listRegisteredProviderTypes()].sort();
}

function restoreProviders(): void {
  clearRegistry();
  registerProviders();
}

describe('listRegisteredProviderTypes', () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    restoreProviders();
  });

  it('returns all provider types after explicit registration', () => {
    registerProviders();

    expect(sortedRegisteredProviderTypes()).toEqual([...EXPECTED_PROVIDER_TYPES].sort());
  });

  it('keeps provider registration idempotent', () => {
    registerProviders();
    registerProviders();

    const types = sortedRegisteredProviderTypes();
    const unique = [...new Set(types)];

    expect(types.length).toBe(unique.length);
    expect(types).toEqual([...EXPECTED_PROVIDER_TYPES].sort());
  });
});
