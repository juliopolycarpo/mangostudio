import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  ProviderSettingsDescriptorSchema,
  ReasoningEffortSchema,
  UpdateProviderRuntimeSettingsBodySchema,
} from '../../src/provider-settings';

describe('provider settings contracts', () => {
  it('accepts every shared reasoning effort', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(Value.Check(ReasoningEffortSchema, effort)).toBe(true);
    }
  });

  it('accepts frontier-scale tool iteration limits', () => {
    expect(
      Value.Check(UpdateProviderRuntimeSettingsBodySchema, {
        maxToolIterations: 1_000,
      })
    ).toBe(true);
  });

  it('rejects invalid update ranges', () => {
    expect(
      Value.Check(UpdateProviderRuntimeSettingsBodySchema, {
        maxToolIterations: 1_001,
      })
    ).toBe(false);
    expect(
      Value.Check(UpdateProviderRuntimeSettingsBodySchema, {
        maxOutputTokens: 0,
      })
    ).toBe(false);
  });

  it('validates a provider descriptor response shape', () => {
    const descriptor = {
      provider: 'openai',
      displayName: 'OpenAI',
      scope: 'provider',
      reasoning: {
        supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
        maxEffort: 'xhigh',
        thinkingToggleSupported: true,
        reasoningWithToolsSupported: true,
      },
      promptCachingSupported: true,
      toolUseSupported: true,
      structuredOutputSupported: true,
      maxOutputTokensLimit: 128000,
      settings: {
        provider: 'openai',
        thinkingEnabled: true,
        reasoningEffort: 'xhigh',
        maxToolIterations: 10,
      },
    };

    expect(Value.Check(ProviderSettingsDescriptorSchema, descriptor)).toBe(true);
  });
});
