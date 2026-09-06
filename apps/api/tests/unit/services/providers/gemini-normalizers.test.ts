import { describe, expect, it } from 'bun:test';
import type { Interactions } from '@google/genai';
import {
  describeAbandonedInteraction,
  extractGeminiUsage,
  hasInlineStepContent,
  isFunctionCallStart,
  narrowGeminiDelta,
  toInteractionParams,
} from '../../../../src/services/providers/gemini/normalizers';

/** Cast partial mock delta to the full SDK type for test purposes. */
const mockDelta = (data: Record<string, unknown>): Interactions.StepDelta['delta'] =>
  data as unknown as Interactions.StepDelta['delta'];

/** Cast partial mock step to the full SDK type for test purposes. */
const mockStep = (data: Record<string, unknown>): Interactions.StepStart['step'] =>
  data as unknown as Interactions.StepStart['step'];

// ---------------------------------------------------------------------------
// isFunctionCallStart
// ---------------------------------------------------------------------------

describe('isFunctionCallStart', () => {
  it('returns true for a function_call step', () => {
    const step = mockStep({
      type: 'function_call',
      id: 'call_1',
      name: 'search',
      arguments: {},
    });
    expect(isFunctionCallStart(step)).toBe(true);
  });

  it('returns false for a model_output step', () => {
    const step = mockStep({ type: 'model_output', content: [] });
    expect(isFunctionCallStart(step)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasInlineStepContent
// ---------------------------------------------------------------------------

describe('hasInlineStepContent', () => {
  it('detects a model_output step that already carries content', () => {
    const step = mockStep({ type: 'model_output', content: [{ type: 'text', text: 'Hi' }] });
    expect(hasInlineStepContent(step)).toBe(true);
  });

  it('detects a thought step that already carries a summary', () => {
    const step = mockStep({ type: 'thought', summary: [{ type: 'text', text: 'Hmm' }] });
    expect(hasInlineStepContent(step)).toBe(true);
  });

  it('returns false for an empty model_output step', () => {
    expect(hasInlineStepContent(mockStep({ type: 'model_output' }))).toBe(false);
  });

  it('returns false for a function_call step', () => {
    const step = mockStep({ type: 'function_call', id: 'c', name: 'n', arguments: {} });
    expect(hasInlineStepContent(step)).toBe(false);
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

  it('narrows arguments_delta to its raw JSON fragment', () => {
    const delta = mockDelta({ type: 'arguments_delta', arguments: '{"query":' });
    expect(narrowGeminiDelta(delta)).toEqual({
      kind: 'arguments_delta',
      arguments: '{"query":',
    });
  });

  it('narrows arguments_delta without a fragment to an empty string', () => {
    const delta = mockDelta({ type: 'arguments_delta' });
    expect(narrowGeminiDelta(delta)).toEqual({ kind: 'arguments_delta', arguments: '' });
  });

  it('narrows thought_summary delta', () => {
    const delta = mockDelta({
      type: 'thought_summary',
      content: { type: 'text', text: 'Thinking...' },
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

// ---------------------------------------------------------------------------
// describeAbandonedInteraction
// ---------------------------------------------------------------------------

describe('describeAbandonedInteraction', () => {
  it('describes each status the interaction cannot be continued from', () => {
    expect(describeAbandonedInteraction('failed')).toBe(
      'Gemini reported that the interaction failed.'
    );
    expect(describeAbandonedInteraction('cancelled')).toBe(
      'Gemini cancelled the interaction before it produced a result.'
    );
    expect(describeAbandonedInteraction('budget_exceeded')).toBe(
      'Gemini halted the interaction: the token budget was exceeded.'
    );
  });

  it.each(['in_progress', 'queued', 'requires_action', 'incomplete', 'completed'])(
    'returns undefined for the continuable status %s',
    (status) => {
      expect(describeAbandonedInteraction(status)).toBeUndefined();
    }
  );

  it('returns undefined for a status the SDK union does not name', () => {
    // The status field is `... | (string & {})`, so an unrecognised value must
    // not be read as a failure.
    expect(describeAbandonedInteraction('some_future_status')).toBeUndefined();
  });
});
