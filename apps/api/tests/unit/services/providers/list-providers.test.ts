import { describe, expect, it } from 'bun:test';
import { listRegisteredProviderTypes } from '../../../../src/services/providers/registry';

// Import providers to trigger their self-registration side effects
import '../../../../src/services/providers/gemini-provider';
import '../../../../src/services/providers/openai-compatible-provider';
import '../../../../src/services/providers/anthropic-provider';

describe('listRegisteredProviderTypes', () => {
  it('returns all registered provider types after imports', () => {
    const types = listRegisteredProviderTypes();

    expect(types).toContain('gemini');
    expect(types).toContain('openai-compatible');
    expect(types).toContain('anthropic');
  });

  it('returns an array of unique provider types', () => {
    const types = listRegisteredProviderTypes();
    const unique = [...new Set(types)];
    expect(types.length).toBe(unique.length);
  });
});
