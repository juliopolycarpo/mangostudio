import { describe, expect, it } from 'bun:test';
import {
  getGeminiFamily,
  buildTextThinkingConfig,
  buildInteractionsThinkingConfig,
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

  it('defaults unknown models to gemini-3', () => {
    expect(getGeminiFamily('gemini-4-ultra')).toBe('gemini-3');
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

  describe('Gemini 2.5 models', () => {
    it('maps high effort to thinking_budget 32768 for Pro', () => {
      const config = buildInteractionsThinkingConfig('gemini-2.5-pro-preview', true, 'high');
      expect(config).toEqual({ thinking_budget: 32768, thinking_summaries: 'auto' });
    });

    it('maps high effort to thinking_budget 24576 for Flash', () => {
      const config = buildInteractionsThinkingConfig('gemini-2.5-flash', true, 'high');
      expect(config).toEqual({ thinking_budget: 24576, thinking_summaries: 'auto' });
    });

    it('maps medium effort to thinking_budget 8192', () => {
      const config = buildInteractionsThinkingConfig('gemini-2.5-flash', true, 'medium');
      expect(config).toEqual({ thinking_budget: 8192, thinking_summaries: 'auto' });
    });

    it('uses budget 0 when thinking disabled on Flash', () => {
      const config = buildInteractionsThinkingConfig('gemini-2.5-flash', false, 'medium');
      expect(config).toEqual({ thinking_budget: 0, thinking_summaries: 'auto' });
    });

    it('uses budget 128 when thinking disabled on Pro', () => {
      const config = buildInteractionsThinkingConfig('gemini-2.5-pro-preview', false, 'medium');
      expect(config).toEqual({ thinking_budget: 128, thinking_summaries: 'auto' });
    });
  });
});
