import { describe, expect, it } from 'bun:test';
import { listRegisteredProviderTypes } from '../../../../src/services/providers/core/provider-registry';

// Import providers to trigger their self-registration side effects
import '../../../../src/services/providers/gemini/index';
import '../../../../src/services/providers/openai-compatible/index';
import '../../../../src/services/providers/anthropic/index';
import '../../../../src/services/providers/deepseek/index';

describe('listRegisteredProviderTypes', () => {
  it('returns all registered provider types after imports', () => {
    const types = listRegisteredProviderTypes();

    expect(types).toContain('gemini');
    expect(types).toContain('openai-compatible');
    expect(types).toContain('anthropic');
    expect(types).toContain('deepseek');
  });

  it('returns an array of unique provider types', () => {
    const types = listRegisteredProviderTypes();
    const unique = [...new Set(types)];
    expect(types.length).toBe(unique.length);
  });
});
