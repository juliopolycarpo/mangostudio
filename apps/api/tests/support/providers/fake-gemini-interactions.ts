import type { InteractionSSEEvent } from '../../../src/services/providers/gemini/normalizers';

/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion --
   All assertions in this file are intentional SDK boundary casts.
   The @google/genai strict types do not accept our test fixture shapes. */

type CreateFn = (
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<AsyncIterable<InteractionSSEEvent>>;

/**
 * Builds a fake Gemini Interactions client that delegates `interactions.create`
 * to the supplied `create` function.
 *
 * @param create - Callback that receives the interaction params and signal.
 * @returns A GoogleGenAI-shaped object safe to pass as the injected client.
 */
export function createFakeGeminiInteractionsClient(create: CreateFn): Record<string, unknown> {
  return {
    interactions: {
      create,
    },
  };
}

/** Yields a completed interaction event with the given id. */
export async function* completedInteractionEvent(
  id = 'int_new',
  inputTokens = 12
): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'interaction.complete',
    interaction: { id, usage: { total_input_tokens: inputTokens } },
  } as InteractionSSEEvent;
}

/** Yields a text delta event. */
export async function* textDeltaEvent(text: string): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'content.delta',
    delta: { type: 'text', text },
  } as InteractionSSEEvent;
}

/** Yields a function_call start event. */
export async function* functionCallStartEvent(
  index: number,
  id: string,
  name: string
): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'content.start',
    index,
    content: { type: 'function_call', id, name },
  } as InteractionSSEEvent;
}

/** Yields a function_call delta event with partial arguments. */
export async function* functionCallDeltaEvent(
  index: number,
  id: string,
  name: string,
  args: Record<string, unknown>
): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'content.delta',
    index,
    delta: { type: 'function_call', id, name, arguments: args },
  } as InteractionSSEEvent;
}

/** Yields a content.stop event for a function call. */
export async function* functionCallStopEvent(index: number): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'content.stop',
    index,
  } as InteractionSSEEvent;
}

/** Yields a reasoning/thought summary delta event. */
export async function* thoughtSummaryEvent(text: string): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'content.delta',
    delta: { type: 'thought_summary', content: { text } },
  } as InteractionSSEEvent;
}

/** Convenience: chains multiple async iterables into one. */
export async function* chainEvents(
  ...iterables: AsyncIterable<InteractionSSEEvent>[]
): AsyncIterable<InteractionSSEEvent> {
  for (const iterable of iterables) {
    for await (const event of iterable) {
      yield event;
    }
  }
}
