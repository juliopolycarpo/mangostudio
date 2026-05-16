import { describe, expect, it } from 'bun:test';
import {
  MAX_TOOL_ITERATIONS_DEFAULT,
  MAX_TOOL_ITERATIONS_MAX,
} from '@mangostudio/shared/app-settings';
import {
  buildProviderSettingsDescriptor,
  mergeProviderRuntimeSettings,
  normalizeProviderRuntimeSettings,
} from '../../../../src/services/providers/core/provider-settings-policy';

describe('provider settings policy', () => {
  it('maps DeepSeek compatible efforts to supported values', () => {
    expect(
      normalizeProviderRuntimeSettings('deepseek', { reasoningEffort: 'xhigh' })
    ).toMatchObject({
      reasoningEffort: 'max',
    });
    expect(normalizeProviderRuntimeSettings('deepseek', { reasoningEffort: 'low' })).toMatchObject({
      reasoningEffort: 'high',
    });
  });

  it('normalizes unsupported Anthropic efforts to its maximum supported effort', () => {
    expect(normalizeProviderRuntimeSettings('anthropic', { reasoningEffort: 'max' })).toMatchObject(
      {
        reasoningEffort: 'high',
      }
    );
  });

  it('allows OpenAI xhigh without DeepSeek-specific mapping', () => {
    const descriptor = buildProviderSettingsDescriptor('openai', { reasoningEffort: 'xhigh' });

    expect(descriptor.reasoning.supportedEfforts).toContain('xhigh');
    expect(descriptor.settings.reasoningEffort).toBe('xhigh');
  });

  it('lets request settings override saved defaults', () => {
    const settings = mergeProviderRuntimeSettings(
      'deepseek',
      { provider: 'deepseek', reasoningEffort: 'max', maxToolIterations: 5 },
      { provider: 'deepseek', reasoningEffort: 'high', maxToolIterations: 2 }
    );

    expect(settings.reasoningEffort).toBe('high');
    expect(settings.maxToolIterations).toBe(2);
  });

  it('defaults and clamps tool iteration limits for frontier-scale runs', () => {
    expect(normalizeProviderRuntimeSettings('openai', {}).maxToolIterations).toBe(
      MAX_TOOL_ITERATIONS_DEFAULT
    );
    expect(
      normalizeProviderRuntimeSettings('openai', { maxToolIterations: 2_000 }).maxToolIterations
    ).toBe(MAX_TOOL_ITERATIONS_MAX);
  });
});
