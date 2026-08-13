import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  DEPRECATED_PROVIDERS,
  isDeprecatedModelId,
  isDeprecatedProvider,
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
      deprecated: false,
    };

    expect(Value.Check(ProviderSettingsDescriptorSchema, descriptor)).toBe(true);
  });

  // The Cursor descriptor is still described — an existing connector's settings
  // page renders from it — and now says the provider is deprecated. `deprecated`
  // is required rather than optional so a server that forgot to set it fails
  // validation instead of quietly reading as "supported".
  it('describes the deprecated Cursor provider', () => {
    expect(
      Value.Check(ProviderSettingsDescriptorSchema, {
        provider: 'cursor',
        displayName: 'Cursor',
        scope: 'provider',
        reasoning: {
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          thinkingToggleSupported: true,
          reasoningWithToolsSupported: false,
        },
        promptCachingSupported: false,
        toolUseSupported: true,
        structuredOutputSupported: false,
        maxOutputTokensLimit: 128000,
        settings: {
          provider: 'cursor',
          thinkingEnabled: true,
          reasoningEffort: 'medium',
          maxToolIterations: 10,
        },
        deprecated: true,
      })
    ).toBe(true);
  });

  it('rejects a descriptor that omits the deprecation flag', () => {
    expect(
      Value.Check(ProviderSettingsDescriptorSchema, {
        provider: 'cursor',
        displayName: 'Cursor',
        scope: 'provider',
        reasoning: {
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          thinkingToggleSupported: true,
          reasoningWithToolsSupported: false,
        },
        promptCachingSupported: false,
        toolUseSupported: true,
        structuredOutputSupported: false,
        maxOutputTokensLimit: 128000,
        settings: {
          provider: 'cursor',
          thinkingEnabled: true,
          reasoningEffort: 'medium',
          maxToolIterations: 10,
        },
      })
    ).toBe(false);
  });

  it('names Cursor, and only Cursor, as deprecated', () => {
    expect([...DEPRECATED_PROVIDERS]).toEqual(['cursor']);
    expect(isDeprecatedProvider('cursor')).toBe(true);
    expect(isDeprecatedProvider('openai')).toBe(false);
  });

  it('recognizes stored Cursor model ids even without a catalog entry', () => {
    expect(isDeprecatedModelId('cursor/composer-2.5')).toBe(true);
    expect(isDeprecatedModelId('cursor/auto')).toBe(true);
    expect(isDeprecatedModelId('gpt-4o')).toBe(false);
    expect(isDeprecatedModelId('cursor')).toBe(false);
  });
});
