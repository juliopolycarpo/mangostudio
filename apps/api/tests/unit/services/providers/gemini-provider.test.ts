import { describe, expect, it } from 'bun:test';

describe('gemini-provider adapter', () => {
  it('providerType is gemini', async () => {
    // Import triggers self-registration; we verify the adapter shape via the registry.
    const { geminiProvider } = await import('../../../../src/services/providers/gemini/index');
    expect(geminiProvider.providerType).toBe('gemini');
  });

  it('implements the required AIProvider methods', async () => {
    const { geminiProvider } = await import('../../../../src/services/providers/gemini/index');
    const provider = geminiProvider;

    expect(typeof provider.generateText).toBe('function');
    expect(typeof provider.listModels).toBe('function');
    expect(typeof provider.validateApiKey).toBe('function');
    expect(typeof provider.resolveApiKey).toBe('function');
  });

  it('implements optional generateImage', async () => {
    const { geminiProvider } = await import('../../../../src/services/providers/gemini/index');
    expect(typeof geminiProvider.generateImage).toBe('function');
  });

  it('is registered in the provider registry after import', async () => {
    await import('../../../../src/services/providers/gemini/index');
    const { getProvider } = await import(
      '../../../../src/services/providers/core/provider-registry'
    );
    const provider = getProvider('gemini');
    expect(provider.providerType).toBe('gemini');
  });
});
