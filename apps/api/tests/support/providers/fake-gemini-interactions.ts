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
  inputTokens = 12,
  status = 'completed'
): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'interaction.completed',
    interaction: { id, status, usage: { total_input_tokens: inputTokens } },
  } as InteractionSSEEvent;
}

/** Yields the opening interaction.created event, before any step. */
export async function* createdInteractionEvent(
  id = 'int_new',
  status = 'in_progress'
): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'interaction.created',
    interaction: { id, status },
  } as InteractionSSEEvent;
}

/** Yields an out-of-band interaction.status_update event. */
export async function* interactionStatusEvent(
  id: string,
  status: string
): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'interaction.status_update',
    interaction_id: id,
    status,
  } as InteractionSSEEvent;
}

/** Yields a text delta event. */
export async function* textDeltaEvent(text: string): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'step.delta',
    index: 0,
    delta: { type: 'text', text },
  } as InteractionSSEEvent;
}

/** Yields a function_call step.start event. */
export async function* functionCallStartEvent(
  index: number,
  id: string,
  name: string
): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'step.start',
    index,
    step: { type: 'function_call', id, name, arguments: {} },
  } as InteractionSSEEvent;
}

/** Yields an arguments_delta event carrying a JSON fragment for the call. */
export async function* functionCallDeltaEvent(
  index: number,
  argumentsFragment: string
): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'step.delta',
    index,
    delta: { type: 'arguments_delta', arguments: argumentsFragment },
  } as InteractionSSEEvent;
}

/** Yields a step.stop event for a function call. */
export async function* functionCallStopEvent(index: number): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'step.stop',
    index,
  } as InteractionSSEEvent;
}

/** Yields a reasoning/thought summary delta event. */
export async function* thoughtSummaryEvent(text: string): AsyncIterable<InteractionSSEEvent> {
  await Promise.resolve();
  yield {
    event_type: 'step.delta',
    index: 0,
    delta: { type: 'thought_summary', content: { type: 'text', text } },
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
