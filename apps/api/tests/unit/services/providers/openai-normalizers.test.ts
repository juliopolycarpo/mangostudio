import { describe, expect, it } from 'bun:test';
import type { Responses } from 'openai/resources/responses/responses';
import { extractResponsesUsage } from '../../../../src/services/providers/openai/normalizers';

/** Cast partial mock to the full SDK type for test purposes. */
const mockResponse = (data: Record<string, unknown>): Responses.Response =>
  data as unknown as Responses.Response;

// ---------------------------------------------------------------------------
// extractResponsesUsage
// ---------------------------------------------------------------------------

describe('extractResponsesUsage', () => {
  it('extracts input tokens when present and positive', () => {
    const response = mockResponse({
      usage: { input_tokens: 150 },
    });
    expect(extractResponsesUsage(response)).toEqual({ inputTokens: 150 });
  });

  it('returns undefined when usage is missing', () => {
    const response = mockResponse({});
    expect(extractResponsesUsage(response)).toEqual({ inputTokens: undefined });
  });

  it('returns undefined when input_tokens is zero', () => {
    const response = mockResponse({
      usage: { input_tokens: 0 },
    });
    expect(extractResponsesUsage(response)).toEqual({ inputTokens: undefined });
  });

  it('returns undefined when input_tokens is negative', () => {
    const response = mockResponse({
      usage: { input_tokens: -10 },
    });
    expect(extractResponsesUsage(response)).toEqual({ inputTokens: undefined });
  });

  it('returns undefined when input_tokens is not a number', () => {
    const response = mockResponse({
      usage: { input_tokens: 'not a number' },
    });
    expect(extractResponsesUsage(response)).toEqual({ inputTokens: undefined });
  });
});
