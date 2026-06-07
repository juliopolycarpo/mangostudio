import { describe, expect, it } from 'bun:test';
import type { Interactions } from '@google/genai';
import {
  extractGeminiUsage,
  isFunctionCallStart,
  narrowGeminiDelta,
  toInteractionParams,
} from '../../../../src/services/providers/gemini/normalizers';

/** Cast partial mock delta to the full SDK type for test purposes. */
const mockDelta = (data: Record<string, unknown>): Interactions.ContentDelta['delta'] =>
  data as unknown as Interactions.ContentDelta['delta'];

/** Cast partial mock content to the full SDK type for test purposes. */
const mockContent = (data: Record<string, unknown>): Interactions.ContentStart['content'] =>
  data as unknown as Interactions.ContentStart['content'];

// ---------------------------------------------------------------------------
// isFunctionCallStart
// ---------------------------------------------------------------------------

describe('isFunctionCallStart', () => {
  it('returns true for function_call content', () => {
    const content = mockContent({
      type: 'function_call',
      id: 'call_1',
      name: 'search',
    });
    expect(isFunctionCallStart(content)).toBe(true);
  });

  it('returns false for text content', () => {
    const content = mockContent({ type: 'text', text: 'Hello' });
    expect(isFunctionCallStart(content)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// narrowGeminiDelta
// ---------------------------------------------------------------------------

describe('narrowGeminiDelta', () => {
  it('narrows text delta', () => {
    const delta = mockDelta({ type: 'text', text: 'Hello' });
    expect(narrowGeminiDelta(delta)).toEqual({ kind: 'text', text: 'Hello' });
  });

  it('narrows function_call delta', () => {
    const delta = mockDelta({
      type: 'function_call',
      id: 'call_1',
      name: 'search',
      arguments: { query: 'test' },
    });
    expect(narrowGeminiDelta(delta)).toEqual({
      kind: 'function_call',
      id: 'call_1',
      name: 'search',
      args: { query: 'test' },
    });
  });

  it('narrows thought_summary delta', () => {
    const delta = mockDelta({
      type: 'thought_summary',
      content: { text: 'Thinking...' },
    });
    expect(narrowGeminiDelta(delta)).toEqual({
      kind: 'thought_summary',
      text: 'Thinking...',
    });
  });

  it('narrows thought_summary delta without content', () => {
    const delta = mockDelta({ type: 'thought_summary' });
    expect(narrowGeminiDelta(delta)).toEqual({ kind: 'thought_summary', text: '' });
  });

  it('narrows thought_signature delta', () => {
    const delta = mockDelta({ type: 'thought_signature' });
    expect(narrowGeminiDelta(delta)).toEqual({ kind: 'thought_signature' });
  });

  it('returns other for unknown delta type', () => {
    const delta = mockDelta({ type: 'unknown_type' });
    expect(narrowGeminiDelta(delta)).toEqual({ kind: 'other' });
  });
});

// ---------------------------------------------------------------------------
// toInteractionParams
// ---------------------------------------------------------------------------

describe('toInteractionParams', () => {
  it('passes through params as CreateModelInteractionParamsStreaming', () => {
    const params = { model: 'gemini-2.0-flash', input: 'Hello', stream: true as const };
    const result = toInteractionParams(params);
    expect(result).toBe(params);
  });
});

// ---------------------------------------------------------------------------
// extractGeminiUsage
// ---------------------------------------------------------------------------

describe('extractGeminiUsage', () => {
  it('extracts cached and input tokens', () => {
    const usage = { total_cached_tokens: 100, total_input_tokens: 500 };
    expect(extractGeminiUsage(usage)).toEqual({
      cachedTokens: 100,
      totalInputTokens: 500,
    });
  });

  it('returns zeros for undefined usage', () => {
    expect(extractGeminiUsage(undefined)).toEqual({
      cachedTokens: 0,
      totalInputTokens: 0,
    });
  });

  it('returns zeros for usage without token fields', () => {
    const usage = {};
    expect(extractGeminiUsage(usage)).toEqual({
      cachedTokens: 0,
      totalInputTokens: 0,
    });
  });

  it('handles partial token fields', () => {
    const usage = { total_input_tokens: 200 };
    expect(extractGeminiUsage(usage)).toEqual({
      cachedTokens: 0,
      totalInputTokens: 200,
    });
  });
});
