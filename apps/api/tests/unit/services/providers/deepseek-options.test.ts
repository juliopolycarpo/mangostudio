import { describe, expect, it } from 'bun:test';
import {
  buildDeepSeekProviderOptions,
  DEFAULT_DEEPSEEK_BASE_URL,
  normalizeDeepSeekBaseUrl,
} from '../../../../src/services/providers/deepseek/options';

describe('normalizeDeepSeekBaseUrl', () => {
  it('falls back to the default base URL when the value is blank', () => {
    expect(normalizeDeepSeekBaseUrl('  ')).toBe(DEFAULT_DEEPSEEK_BASE_URL);
    expect(normalizeDeepSeekBaseUrl(undefined)).toBe(DEFAULT_DEEPSEEK_BASE_URL);
  });

  it('trims whitespace and strips trailing slashes', () => {
    expect(normalizeDeepSeekBaseUrl(' https://api.deepseek.com/v1/// ')).toBe(
      'https://api.deepseek.com/v1'
    );
  });
});

describe('buildDeepSeekProviderOptions', () => {
  it('returns undefined when thinking is disabled', () => {
    expect(
      buildDeepSeekProviderOptions({
        thinkingEnabled: false,
        reasoningEffort: 'xhigh',
      })
    ).toBeUndefined();
  });

  it('enables thinking and normalizes reasoning effort for DeepSeek', () => {
    expect(
      buildDeepSeekProviderOptions({
        thinkingEnabled: true,
        reasoningEffort: 'xhigh',
      })
    ).toEqual({
      deepseek: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'max',
      },
    });
  });
});
