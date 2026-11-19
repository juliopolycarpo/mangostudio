import { describe, expect, it } from 'bun:test';

import Value from 'typebox/value';

import { ModelCapabilitiesSchema, ModelCatalogResponseSchema } from '../../src/catalog';

const BASE_CAPABILITIES = { text: true, image: false, streaming: true, tools: true };

describe('ModelCapabilitiesSchema — deprecated internalAgentTools', () => {
  it.each([true, false])(
    'still accepts a payload carrying internalAgentTools: %p',
    (internalAgentTools) => {
      const payload = { ...BASE_CAPABILITIES, internalAgentTools };

      expect(Value.Check(ModelCapabilitiesSchema, payload)).toBe(true);
    }
  );

  it('accepts a payload that omits the field', () => {
    expect(Value.Check(ModelCapabilitiesSchema, BASE_CAPABILITIES)).toBe(true);
  });

  it('still rejects a non-boolean internalAgentTools', () => {
    const payload = { ...BASE_CAPABILITIES, internalAgentTools: 'yes' };

    expect(Value.Check(ModelCapabilitiesSchema, payload)).toBe(false);
  });

  it('accepts a catalog response whose model carries the field', () => {
    const model = {
      modelId: 'gpt-test',
      resourceName: 'models/gpt-test',
      displayName: 'GPT Test',
      supportedActions: ['generateContent'],
      capabilities: { ...BASE_CAPABILITIES, internalAgentTools: true },
    };
    const payload = {
      configured: true,
      status: 'ready',
      allModels: [model],
      textModels: [model],
      imageModels: [],
      discoveredTextModels: [model],
      discoveredImageModels: [],
    };

    expect(Value.Check(ModelCatalogResponseSchema, payload)).toBe(true);
  });
});
