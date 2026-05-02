/**
 * Fake DeepSeek SSE chunk generators for agent-stream tests.
 *
 * Builds on top of the shared Chat Completions fake helpers in
 * `fake-chat-completions.ts` and adds DeepSeek-specific fields:
 *   - `reasoning_content` in delta
 *   - `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` in usage
 *
 * Each factory returns a sync `Generator` so callers can compose
 * scenarios with `chainChunks` from `fake-chat-completions`.
 */

import type OpenAI from 'openai';

type Chunk = Record<string, unknown>;

/** Delta with both `content` and `reasoning_content`. */
export function* reasoningDeltaChunk(reasoning: string, content?: string): Generator<Chunk> {
  const delta: Record<string, unknown> = { content: content ?? null, reasoning_content: reasoning };
  yield { choices: [{ delta, finish_reason: null }] };
}

/** Delta with only `reasoning_content` (thinking before text). */
export function* reasoningOnlyChunk(text: string): Generator<Chunk> {
  yield {
    choices: [{ delta: { content: null, reasoning_content: text }, finish_reason: null }],
  };
}

/** Delta with `reasoning_content` AND a tool call start. */
export function* reasoningWithToolCallChunk(
  reasoning: string,
  toolIndex: number,
  toolId: string,
  toolName: string
): Generator<Chunk> {
  yield {
    choices: [
      {
        delta: {
          content: null,
          reasoning_content: reasoning,
          tool_calls: [
            { index: toolIndex, id: toolId, function: { name: toolName, arguments: '' } },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

/** Usage chunk with DeepSeek cache metrics. */
export function* deepSeekUsageChunk(
  promptTokens: number,
  completionTokens: number,
  cacheHit?: number,
  cacheMiss?: number
): Generator<Chunk> {
  const usage: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
  };
  if (cacheHit !== undefined) usage.prompt_cache_hit_tokens = cacheHit;
  if (cacheMiss !== undefined) usage.prompt_cache_miss_tokens = cacheMiss;
  yield { choices: [], usage };
}

/**
 * Full tool-call sequence: reasoning → tool start → args → stop.
 *
 * Yields the chunks that DeepSeek emits during a single tool-call
 * assistant turn with thinking mode enabled.
 */
export function* toolCallSequence(
  reasoning: string,
  toolId: string,
  toolName: string,
  argsJson: string
): Generator<Chunk> {
  yield* reasoningOnlyChunk(reasoning);
  yield* exactToolCallStartChunk(toolId, toolName);
  yield* exactToolCallArgsChunk(argsJson);
  yield* exactToolCallStopChunk();
}

function* exactToolCallStartChunk(id: string, name: string): Generator<Chunk> {
  yield {
    choices: [
      {
        delta: {
          content: null,
          tool_calls: [{ index: 0, id, function: { name, arguments: '' } }],
        },
        finish_reason: null,
      },
    ],
  };
}

function* exactToolCallArgsChunk(args: string): Generator<Chunk> {
  yield {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: args } }],
        },
        finish_reason: null,
      },
    ],
  };
}

function* exactToolCallStopChunk(): Generator<Chunk> {
  yield {
    choices: [{ delta: {}, finish_reason: 'stop' }],
  };
}

/** Helper: creates an OpenAI-shaped client that returns the given stream. */
export function createFakeDeepSeekClient(stream: AsyncIterable<Chunk>): Pick<OpenAI, 'chat'> {
  return {
    chat: {
      completions: {
        create: () => Promise.resolve(stream),
      } as unknown as OpenAI.ChatCompletion,
    },
  } as unknown as Pick<OpenAI, 'chat'>;
}
