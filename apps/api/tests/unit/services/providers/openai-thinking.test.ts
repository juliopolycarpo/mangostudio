import { describe, expect, it } from 'bun:test';
import { isReasoningModel } from '@mangostudio/shared/utils/model-detection';
import {
  extractReasoningFromCompleted,
  streamWithResponsesAPI,
} from '../../../../src/services/providers/openai-provider';
import type { Responses } from 'openai/resources/responses/responses';
import type { StreamingChunk } from '../../../../src/services/providers/types';

/** Cast partial mock data to the full SDK type for test purposes. */
const mockResponse = (data: Record<string, unknown>): Responses.Response =>
  data as unknown as Responses.Response;

/**
 * Unit tests for OpenAI provider reasoning support.
 * Tests model detection, Responses API streaming, and reasoning extraction.
 *
 * streamWithResponsesAPI and extractReasoningFromCompleted are tested directly
 * to avoid Bun module-cache contamination from other test files that import the
 * provider with the real secretService.
 */

// ---------------------------------------------------------------------------
// isReasoningModel detection
// ---------------------------------------------------------------------------

describe('isReasoningModel detection', () => {
  it('detects o-series models', () => {
    expect(isReasoningModel('o1')).toBe(true);
    expect(isReasoningModel('o3-mini')).toBe(true);
    expect(isReasoningModel('o4-mini')).toBe(true);
  });

  it('detects gpt-5 family', () => {
    expect(isReasoningModel('gpt-5')).toBe(true);
    expect(isReasoningModel('gpt-5.1-mini')).toBe(true);
    expect(isReasoningModel('gpt-5.4-nano')).toBe(true);
  });

  it('does not match non-reasoning models', () => {
    expect(isReasoningModel('gpt-4o')).toBe(false);
    expect(isReasoningModel('gpt-4o-mini')).toBe(false);
    expect(isReasoningModel('dall-e-3')).toBe(false);
  });

  it('detects Anthropic reasoning models', () => {
    expect(isReasoningModel('claude-3-5-sonnet-20241022')).toBe(true);
    expect(isReasoningModel('claude-sonnet-4-5-20250514')).toBe(true);
    expect(isReasoningModel('claude-opus-4-20250514')).toBe(true);
  });

  it('detects Gemini reasoning models (2.5+)', () => {
    expect(isReasoningModel('gemini-2.5-pro')).toBe(true);
    expect(isReasoningModel('gemini-2.5-flash')).toBe(true);
    expect(isReasoningModel('gemini-3.0-pro')).toBe(true);
    expect(isReasoningModel('gemini-3.1-flash-lite-preview')).toBe(true);
  });

  it('does not match Gemini 2.0', () => {
    expect(isReasoningModel('gemini-2.0-flash')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractReasoningFromCompleted
// ---------------------------------------------------------------------------

describe('extractReasoningFromCompleted', () => {
  it('extracts reasoning from summary array', () => {
    const result = extractReasoningFromCompleted(
      mockResponse({
        output: [
          {
            type: 'reasoning',
            summary: [
              { type: 'summary_text', text: 'First block.' },
              { type: 'summary_text', text: 'Second block.' },
            ],
          },
        ],
      })
    );

    expect(result).toBe('First block.\n\nSecond block.');
  });

  it('falls back to reasoning content array when no summary', () => {
    const result = extractReasoningFromCompleted(
      mockResponse({
        output: [
          {
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: 'Raw reasoning.' }],
          },
        ],
      })
    );

    expect(result).toBe('Raw reasoning.');
  });

  it('returns null when no reasoning output', () => {
    const result = extractReasoningFromCompleted(
      mockResponse({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }],
      })
    );

    expect(result).toBeNull();
  });

  it('returns null for empty response', () => {
    expect(extractReasoningFromCompleted(mockResponse({}))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// streamWithResponsesAPI — tested with a mock OpenAI client
// ---------------------------------------------------------------------------

/** Creates a fake OpenAI client whose responses.create() yields `events`. */
function createMockClient(events: Array<Record<string, unknown>>) {
  return {
    responses: {
      create: () =>
        Promise.resolve(
          (async function* () {
            await Promise.resolve();
            for (const ev of events) {
              yield ev;
            }
          })()
        ),
    },
  };
}

/** Collects all chunks from a streaming call. */
async function collectChunks(
  client: unknown,
  modelName: string,
  effort: 'low' | 'medium' | 'high' = 'medium'
): Promise<StreamingChunk[]> {
  const chunks: StreamingChunk[] = [];
  for await (const chunk of streamWithResponsesAPI(client as Parameters<typeof streamWithResponsesAPI>[0], {
    userId: 'u1',
    history: [],
    prompt: 'Hello',
    modelName,
    generationConfig: { thinkingEnabled: true, reasoningEffort: effort },
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('streamWithResponsesAPI', () => {
  it('sends reasoning effort and summary=auto to the Responses API', async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const client = {
      responses: {
        create: (params: Record<string, unknown>) => {
          capturedParams = params;
          const empty: Record<string, unknown>[] = [];
          return Promise.resolve(
            (async function* () {
              await Promise.resolve();
              yield* empty;
            })()
          );
        },
      },
    };

    await collectChunks(client, 'o4-mini', 'high');

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(capturedParams!.model).toBe('o4-mini');
  });

  it('yields thinking from reasoning_summary_text.delta', async () => {
    const client = createMockClient([
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'item1',
        summary_index: 0,
        delta: 'Thinking about this...',
      },
      { type: 'response.output_text.delta', delta: 'The answer is 42.' },
    ]);

    const chunks = await collectChunks(client, 'o4-mini');

    expect(chunks[0]).toEqual({ type: 'thinking', text: 'Thinking about this...', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: 'The answer is 42.', done: false });
    expect(chunks[chunks.length - 1]).toEqual({ type: 'text', text: '', done: true });
  });

  it('falls back to reasoning_text.delta when no summary events', async () => {
    const client = createMockClient([
      {
        type: 'response.reasoning_text.delta',
        item_id: 'item1',
        content_index: 0,
        delta: 'Raw reasoning...',
      },
      { type: 'response.output_text.delta', delta: 'Result.' },
    ]);

    const chunks = await collectChunks(client, 'gpt-5', 'low');

    expect(chunks[0]).toEqual({ type: 'thinking', text: 'Raw reasoning...', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: 'Result.', done: false });
  });

  it('deduplicates summary events already seen via delta', async () => {
    const client = createMockClient([
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'item1',
        summary_index: 0,
        delta: 'Streamed thinking.',
      },
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'item1',
        summary_index: 0,
        text: 'Streamed thinking.',
      },
      { type: 'response.output_text.delta', delta: 'Answer.' },
    ]);

    const chunks = await collectChunks(client, 'o4-mini');

    const thinkingChunks = chunks.filter((c) => c.type === 'thinking');
    expect(thinkingChunks.length).toBe(1);
    expect(thinkingChunks[0].text).toBe('Streamed thinking.');
  });

  it('falls back to response.completed reasoning extraction', async () => {
    const client = createMockClient([
      {
        type: 'response.completed',
        response: {
          output: [
            {
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'Fallback reasoning.' }],
            },
          ],
        },
      },
    ]);

    const chunks = await collectChunks(client, 'o4-mini');

    const thinkingChunks = chunks.filter((c) => c.type === 'thinking');
    expect(thinkingChunks.length).toBe(1);
    expect(thinkingChunks[0].text).toBe('Fallback reasoning.');
  });

  it('ignores reasoning_text.delta when summary events were already seen', async () => {
    const client = createMockClient([
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'item1',
        summary_index: 0,
        delta: 'Summary thinking.',
      },
      {
        type: 'response.reasoning_text.delta',
        item_id: 'item1',
        content_index: 0,
        delta: 'Raw duplicate.',
      },
      { type: 'response.output_text.delta', delta: 'Answer.' },
    ]);

    const chunks = await collectChunks(client, 'o4-mini');

    const thinkingChunks = chunks.filter((c) => c.type === 'thinking');
    expect(thinkingChunks.length).toBe(1);
    expect(thinkingChunks[0].text).toBe('Summary thinking.');
  });

  it('handles multiple summary blocks', async () => {
    const client = createMockClient([
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'item1',
        summary_index: 0,
        delta: 'First block.',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'item1',
        summary_index: 1,
        delta: 'Second block.',
      },
      { type: 'response.output_text.delta', delta: 'Answer.' },
    ]);

    const chunks = await collectChunks(client, 'o4-mini');

    const thinkingChunks = chunks.filter((c) => c.type === 'thinking');
    expect(thinkingChunks.length).toBe(2);
    expect(thinkingChunks[0].text).toBe('First block.');
    expect(thinkingChunks[1].text).toBe('Second block.');
  });
});
