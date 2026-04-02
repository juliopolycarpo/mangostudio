import { describe, expect, it } from 'bun:test';
import type { AIProvider } from '../../../../src/services/providers/types';

describe('gemini-provider adapter', () => {
  it('providerType is gemini', async () => {
    // Import triggers self-registration; we verify the adapter shape via the registry.
    const { geminiProvider } = await import('../../../../src/services/providers/gemini-provider');
    expect(geminiProvider.providerType).toBe('gemini');
  });

  it('implements the required AIProvider methods', async () => {
    const { geminiProvider } = await import('../../../../src/services/providers/gemini-provider');
    const provider = geminiProvider as AIProvider;

    expect(typeof provider.generateText).toBe('function');
    expect(typeof provider.listModels).toBe('function');
    expect(typeof provider.validateApiKey).toBe('function');
    expect(typeof provider.resolveApiKey).toBe('function');
  });

  it('implements optional generateImage', async () => {
    const { geminiProvider } = await import('../../../../src/services/providers/gemini-provider');
    expect(typeof geminiProvider.generateImage).toBe('function');
  });

  it('is registered in the provider registry after import', async () => {
    await import('../../../../src/services/providers/gemini-provider');
    const { getProvider } = await import('../../../../src/services/providers/registry');
    const provider = getProvider('gemini');
    expect(provider.providerType).toBe('gemini');
  });
});
