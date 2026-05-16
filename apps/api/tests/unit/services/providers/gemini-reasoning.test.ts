import { describe, expect, it } from 'bun:test';
import {
  buildInteractionsThinkingConfig,
  buildTextThinkingConfig,
  getGeminiFamily,
} from '../../../../src/services/providers/gemini/reasoning-config';

describe('getGeminiFamily', () => {
  it('detects gemini-2.5-pro as gemini-2.5', () => {
    expect(getGeminiFamily('gemini-2.5-pro-preview')).toBe('gemini-2.5');
  });

  it('detects gemini-2.5-flash as gemini-2.5', () => {
    expect(getGeminiFamily('gemini-2.5-flash')).toBe('gemini-2.5');
  });

  it('detects gemini-2.5-flash-lite as gemini-2.5', () => {
    expect(getGeminiFamily('gemini-2.5-flash-lite')).toBe('gemini-2.5');
  });

  it('detects gemini-3-pro as gemini-3', () => {
    expect(getGeminiFamily('gemini-3-pro-preview')).toBe('gemini-3');
  });

  it('detects gemini-3-flash as gemini-3', () => {
    expect(getGeminiFamily('gemini-3-flash-preview')).toBe('gemini-3');
  });

  it('detects gemini-3.1-pro as gemini-3', () => {
    expect(getGeminiFamily('gemini-3.1-pro')).toBe('gemini-3');
  });

  it('detects gemini-4-ultra as gemini-3 (forward-compatible)', () => {
    expect(getGeminiFamily('gemini-4-ultra')).toBe('gemini-3');
  });

  it('detects gemini-2.0-flash as gemini-legacy', () => {
    expect(getGeminiFamily('gemini-2.0-flash')).toBe('gemini-legacy');
  });

  it('detects gemini-1.5-pro as gemini-legacy', () => {
    expect(getGeminiFamily('gemini-1.5-pro')).toBe('gemini-legacy');
  });

  it('defaults completely unknown models to gemini-legacy', () => {
    expect(getGeminiFamily('some-unknown-model')).toBe('gemini-legacy');
  });
});

describe('buildTextThinkingConfig', () => {
  describe('Gemini 3 models', () => {
    it('maps high effort to thinkingLevel HIGH', () => {
      const config = buildTextThinkingConfig('gemini-3-pro-preview', true, 'high');
      expect(config).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
    });

    it('maps medium effort to thinkingLevel MEDIUM', () => {
      const config = buildTextThinkingConfig('gemini-3-flash-preview', true, 'medium');
      expect(config).toEqual({ includeThoughts: true, thinkingLevel: 'MEDIUM' });
    });

    it('maps low effort to thinkingLevel LOW', () => {
      const config = buildTextThinkingConfig('gemini-3.1-pro', true, 'low');
      expect(config).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' });
    });

    it('uses LOW when thinking disabled on Pro (cannot fully disable)', () => {
      const config = buildTextThinkingConfig('gemini-3-pro-preview', false, 'high');
      expect(config).toEqual({ includeThoughts: false, thinkingLevel: 'LOW' });
    });

    it('uses MINIMAL when thinking disabled on Flash', () => {
      const config = buildTextThinkingConfig('gemini-3-flash-preview', false, 'high');
      expect(config).toEqual({ includeThoughts: false, thinkingLevel: 'MINIMAL' });
    });

    it('uses MINIMAL when thinking disabled on Flash-Lite', () => {
      const config = buildTextThinkingConfig('gemini-3.1-flash-lite', false, 'medium');
      expect(config).toEqual({ includeThoughts: false, thinkingLevel: 'MINIMAL' });
    });
  });

  describe('Gemini 2.5 models', () => {
    it('maps medium effort to thinkingBudget 8192', () => {
      const config = buildTextThinkingConfig('gemini-2.5-pro-preview', true, 'medium');
      expect(config).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
    });

    it('maps low effort to thinkingBudget 1024', () => {
      const config = buildTextThinkingConfig('gemini-2.5-flash', true, 'low');
      expect(config).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
    });

    it('maps high effort to 32768 for Pro', () => {
      const config = buildTextThinkingConfig('gemini-2.5-pro-preview', true, 'high');
      expect(config).toEqual({ includeThoughts: true, thinkingBudget: 32768 });
    });

    it('maps high effort to 24576 for Flash', () => {
      const config = buildTextThinkingConfig('gemini-2.5-flash', true, 'high');
      expect(config).toEqual({ includeThoughts: true, thinkingBudget: 24576 });
    });

    it('uses budget 0 when thinking disabled on Flash (can disable)', () => {
      const config = buildTextThinkingConfig('gemini-2.5-flash', false, 'high');
      expect(config).toEqual({ includeThoughts: false, thinkingBudget: 0 });
    });

    it('uses budget 128 when thinking disabled on Pro (minimum)', () => {
      const config = buildTextThinkingConfig('gemini-2.5-pro-preview', false, 'high');
      expect(config).toEqual({ includeThoughts: false, thinkingBudget: 128 });
    });
  });

  describe('Legacy models (Gemini 2.0 and older)', () => {
    it('returns undefined for gemini-2.0-flash', () => {
      expect(buildTextThinkingConfig('gemini-2.0-flash', true, 'high')).toBeUndefined();
    });

    it('returns undefined for gemini-1.5-pro', () => {
      expect(buildTextThinkingConfig('gemini-1.5-pro', false, 'medium')).toBeUndefined();
    });
  });
});

describe('buildInteractionsThinkingConfig', () => {
  describe('Gemini 3 models', () => {
    it('maps low effort to thinking_level low', () => {
      const config = buildInteractionsThinkingConfig('gemini-3-pro-preview', true, 'low');
      expect(config).toEqual({ thinking_level: 'low', thinking_summaries: 'auto' });
    });

    it('maps high effort to thinking_level high', () => {
      const config = buildInteractionsThinkingConfig('gemini-3-flash-preview', true, 'high');
      expect(config).toEqual({ thinking_level: 'high', thinking_summaries: 'auto' });
    });

    it('uses low when thinking disabled on Pro', () => {
      const config = buildInteractionsThinkingConfig('gemini-3-pro-preview', false, 'high');
      expect(config).toEqual({ thinking_level: 'low', thinking_summaries: 'auto' });
    });

    it('uses minimal when thinking disabled on Flash', () => {
      const config = buildInteractionsThinkingConfig('gemini-3.1-flash-preview', false, 'high');
      expect(config).toEqual({ thinking_level: 'minimal', thinking_summaries: 'auto' });
    });
  });

  describe('Gemini 2.5 models (thinking_summaries only, no thinking_level)', () => {
    it('returns thinking_summaries auto for 2.5 Pro with thinking enabled', () => {
      expect(buildInteractionsThinkingConfig('gemini-2.5-pro-preview', true, 'high')).toEqual({
        thinking_summaries: 'auto',
      });
    });

    it('returns thinking_summaries auto for 2.5 Flash with thinking enabled', () => {
      expect(buildInteractionsThinkingConfig('gemini-2.5-flash', true, 'medium')).toEqual({
        thinking_summaries: 'auto',
      });
    });

    it('returns undefined for 2.5 Flash with thinking disabled', () => {
      expect(buildInteractionsThinkingConfig('gemini-2.5-flash', false, 'medium')).toBeUndefined();
    });

    it('returns undefined for 2.5 Pro with thinking disabled', () => {
      expect(
        buildInteractionsThinkingConfig('gemini-2.5-pro-preview', false, 'low')
      ).toBeUndefined();
    });
  });

  describe('Legacy models (Gemini 2.0 and older)', () => {
    it('returns undefined for gemini-2.0-flash', () => {
      expect(buildInteractionsThinkingConfig('gemini-2.0-flash', true, 'high')).toBeUndefined();
    });

    it('returns undefined for gemini-1.5-pro', () => {
      expect(buildInteractionsThinkingConfig('gemini-1.5-pro', false, 'medium')).toBeUndefined();
    });
  });
});
