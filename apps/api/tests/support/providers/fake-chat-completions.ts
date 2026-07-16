type ChatCompletionChunk = Record<string, unknown>;

type CreateFn = (
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<AsyncIterable<ChatCompletionChunk>>;

/**
 * Builds a fake OpenAI-compatible client that delegates
 * `chat.completions.create` to the supplied `create` function.
 *
 * @param create - Callback that receives chat completion params and signal.
 * @returns An OpenAI-shaped object safe to pass to `streamOAICompatAgentTurn`.
 */
export function createFakeChatCompletionsClient(create: CreateFn): Record<string, unknown> {
  return {
    chat: {
      completions: {
        create,
      },
    },
  };
}

/** Yields a text delta chunk. */
export function* textDeltaChunk(content: string): Generator<ChatCompletionChunk> {
  yield {
    choices: [{ delta: { content }, finish_reason: null }],
  };
}

/** Yields a stop chunk (empty delta with finish_reason). */
export function* stopChunk(): Generator<ChatCompletionChunk> {
  yield {
    choices: [{ delta: {}, finish_reason: 'stop' }],
  };
}

/** Yields a usage chunk (empty choices with usage). */
export function* usageChunk(
  promptTokens: number,
  completionTokens: number
): Generator<ChatCompletionChunk> {
  yield {
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

/** Yields a tool_calls start chunk. */
export function* toolCallStartChunk(
  index: number,
  id: string,
  name: string
): Generator<ChatCompletionChunk> {
  yield {
    choices: [
      {
        delta: {
          tool_calls: [{ index, id, function: { name, arguments: '' } }],
        },
        finish_reason: null,
      },
    ],
  };
}

/** Yields a tool_calls arguments delta chunk. */
export function* toolCallArgumentsDeltaChunk(
  index: number,
  argsDelta: string
): Generator<ChatCompletionChunk> {
  yield {
    choices: [
      {
        delta: {
          tool_calls: [{ index, function: { arguments: argsDelta } }],
        },
        finish_reason: null,
      },
    ],
  };
}

/** Convenience: chains multiple chunk generators into one async iterable. */
export async function* chainChunks(
  ...generators: Generator<ChatCompletionChunk>[]
): AsyncIterable<ChatCompletionChunk> {
  await Promise.resolve();
  for (const gen of generators) {
    for (const chunk of gen) {
      yield chunk;
    }
  }
}
