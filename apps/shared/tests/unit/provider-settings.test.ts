import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
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
      runtimeAvailable: true,
    };

    expect(Value.Check(ProviderSettingsDescriptorSchema, descriptor)).toBe(true);
  });

  it('accepts cursor runtime unavailability reason codes', () => {
    for (const reason of [
      'cursor.node_not_found',
      'cursor.version_insufficient',
      'cursor.sidecar_missing',
      'cursor.sdk_missing',
      'cursor.sdk_incomplete',
      'cursor.native_runtime_missing',
    ]) {
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
          toolUseSupported: false,
          structuredOutputSupported: false,
          maxOutputTokensLimit: 128000,
          settings: {
            provider: 'cursor',
            thinkingEnabled: true,
            reasoningEffort: 'medium',
            maxToolIterations: 10,
          },
          runtimeAvailable: false,
          runtimeUnavailableReason: reason,
          runtimeUnavailableReasonParams: {
            foundVersion: 'v20.0.0',
            packageName: '@cursor/sdk-linux-x64',
            sidecarPath: '/tmp/cursor-sidecar/run-agent.mjs',
          },
        })
      ).toBe(true);
    }
  });

  it('rejects unknown cursor runtime unavailability reason codes', () => {
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
        toolUseSupported: false,
        structuredOutputSupported: false,
        maxOutputTokensLimit: 128000,
        settings: {
          provider: 'cursor',
          thinkingEnabled: true,
          reasoningEffort: 'medium',
          maxToolIterations: 10,
        },
        runtimeAvailable: false,
        runtimeUnavailableReason: 'cursor.unknown',
      })
    ).toBe(false);
  });
});
