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

  it('allows OpenAI xhigh without DeepSeek-specific mapping', async () => {
    const descriptor = await buildProviderSettingsDescriptor('openai', {
      reasoningEffort: 'xhigh',
    });

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

  it('normalizes unsupported cursor efforts to medium', () => {
    expect(normalizeProviderRuntimeSettings('cursor', { reasoningEffort: 'max' })).toMatchObject({
      reasoningEffort: 'medium',
    });
    expect(normalizeProviderRuntimeSettings('cursor', { reasoningEffort: 'xhigh' })).toMatchObject({
      reasoningEffort: 'medium',
    });
  });

  it('exposes cursor reasoning descriptor without MangoStudio tool loop support', async () => {
    const descriptor = await buildProviderSettingsDescriptor('cursor', { reasoningEffort: 'high' });

    expect(descriptor.reasoning.supportedEfforts).toEqual(['low', 'medium', 'high']);
    expect(descriptor.settings.reasoningEffort).toBe('high');
    expect(descriptor.toolUseSupported).toBe(false);
    expect(descriptor.reasoning.reasoningWithToolsSupported).toBe(false);
  });
});
