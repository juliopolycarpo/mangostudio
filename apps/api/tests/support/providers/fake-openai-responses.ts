import { APIError } from 'openai';

type ResponseStreamEvent = Record<string, unknown>;

type CreateFn = (
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<AsyncIterable<ResponseStreamEvent>>;

/**
 * Builds a fake OpenAI client that delegates `responses.create` to the
 * supplied `create` function.
 *
 * @param create - Callback that receives Responses create params and signal.
 * @returns An OpenAI-shaped object safe to pass to `streamAgentTurnWithResponsesAPI`.
 */
export function createFakeOpenAIResponsesClient(create: CreateFn): Record<string, unknown> {
  return {
    responses: {
      create,
    },
  };
}

/** Yields a response.completed event with usage. */
export function* responseCompletedEvent(
  id = 'resp_new',
  inputTokens = 42,
  outputTokens = 10
): Generator<ResponseStreamEvent> {
  yield {
    type: 'response.completed',
    response: {
      id,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };
}

/** Yields a text delta event. */
export function* textDeltaEvent(text: string): Generator<ResponseStreamEvent> {
  yield {
    type: 'response.output_text.delta',
    delta: text,
  };
}

/** Yields a tool_call started event (output_item.added). */
export function* toolCallStartedEvent(
  callId: string,
  name: string
): Generator<ResponseStreamEvent> {
  yield {
    type: 'response.output_item.added',
    item: {
      type: 'function_call',
      call_id: callId,
      name,
    },
  };
}

/** Yields a tool_call arguments delta. */
export function* toolCallArgumentsDeltaEvent(
  itemId: string,
  delta: string
): Generator<ResponseStreamEvent> {
  yield {
    type: 'response.function_call_arguments.delta',
    item_id: itemId,
    delta,
  };
}

/** Yields a tool_call completed event. */
export function* toolCallCompletedEvent(
  itemId: string,
  arguments_: string
): Generator<ResponseStreamEvent> {
  yield {
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    arguments: arguments_,
  };
}

/** Yields a reasoning delta event. */
export function* reasoningDeltaEvent(text: string): Generator<ResponseStreamEvent> {
  yield {
    type: 'response.reasoning_summary_text.delta',
    delta: text,
  };
}

/** Convenience: chains multiple event generators into one async iterable. */
export async function* chainEvents(
  ...generators: Generator<ResponseStreamEvent>[]
): AsyncIterable<ResponseStreamEvent> {
  await Promise.resolve();
  for (const gen of generators) {
    for (const event of gen) {
      yield event;
    }
  }
}

/**
 * Builds a 404 APIError that mimics an expired OpenAI cursor.
 */
export function cursorExpiredError(): APIError {
  return new APIError(
    404,
    { error: { message: 'previous_response_id not found' } },
    'Not Found',
    new Headers({ 'content-type': 'application/json' })
  );
}
