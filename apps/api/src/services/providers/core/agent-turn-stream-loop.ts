import type { AgentEvent } from '../types';
import {
  type ChatCompletionsAccumulator,
  type ChatCompletionsDelta,
  createChatCompletionsAccumulator,
} from './chat-completions-accumulator';

export interface AgentTurnStreamOpenResult<TChunk> {
  readonly stream?: AsyncIterable<TChunk>;
  readonly preludeEvents?: Iterable<AgentEvent>;
  readonly terminalEvents?: Iterable<AgentEvent>;
}

interface AgentTurnStreamLoopOptions<TChunk, TAccumulator, TContext> {
  readonly signal?: AbortSignal;
  readonly completeOnAbort?: boolean;
  readonly openStream: () => Promise<AgentTurnStreamOpenResult<TChunk>>;
  readonly createAccumulator: () => TAccumulator;
  readonly createContext: () => TContext;
  readonly mapChunk: (params: {
    chunk: TChunk;
    accumulator: TAccumulator;
    context: TContext;
  }) => Iterable<AgentEvent>;
  readonly complete: (params: {
    accumulator: TAccumulator;
    context: TContext;
  }) => Iterable<AgentEvent>;
  readonly onError?: (error: unknown) => Iterable<AgentEvent> | null | undefined;
}

export async function* streamAgentTurnLoop<TChunk, TAccumulator, TContext>(
  options: AgentTurnStreamLoopOptions<TChunk, TAccumulator, TContext>
): AsyncGenerator<AgentEvent> {
  try {
    const source = await options.openStream();

    for (const event of source.preludeEvents ?? []) {
      yield event;
    }

    if (!source.stream) {
      for (const event of source.terminalEvents ?? []) {
        yield event;
      }
      return;
    }

    const accumulator = options.createAccumulator();
    const context = options.createContext();

    for await (const chunk of source.stream) {
      if (options.signal?.aborted) {
        if (options.completeOnAbort) break;
        return;
      }

      for (const event of options.mapChunk({ chunk, accumulator, context })) {
        yield event;
      }
    }

    if (options.signal?.aborted && !options.completeOnAbort) return;

    for (const event of options.complete({ accumulator, context })) {
      yield event;
    }
  } catch (error: unknown) {
    const events = options.onError?.(error);
    if (!events) throw error;

    for (const event of events) {
      yield event;
    }
  }
}

interface ChatCompletionsUsage {
  readonly prompt_tokens?: number;
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_cache_miss_tokens?: number;
}

interface ChatCompletionsChoice {
  readonly delta?: ChatCompletionsDelta;
  readonly finish_reason?: unknown;
}

export interface ChatCompletionsAgentStreamChunk {
  readonly choices?: readonly ChatCompletionsChoice[];
  readonly usage?: ChatCompletionsUsage | null;
}

export interface ChatCompletionsAgentStreamContext {
  providerReportedInputTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

interface ChatCompletionsAgentTurnLoopOptions<TChunk> {
  readonly signal?: AbortSignal;
  readonly openStream: () => Promise<AsyncIterable<TChunk>>;
  readonly extractReasoningChunks: (delta: Record<string, unknown>) => string[];
  readonly complete: (params: {
    accumulator: ChatCompletionsAccumulator;
    context: ChatCompletionsAgentStreamContext;
  }) => Iterable<AgentEvent>;
  readonly fallbackErrorMessage: string;
}

export async function* streamChatCompletionsAgentTurnLoop<TChunk>(
  options: ChatCompletionsAgentTurnLoopOptions<TChunk>
): AsyncGenerator<AgentEvent> {
  yield* streamAgentTurnLoop({
    signal: options.signal,
    openStream: async () => ({ stream: await options.openStream() }),
    createAccumulator: () =>
      createChatCompletionsAccumulator({ extractReasoningChunks: options.extractReasoningChunks }),
    createContext: createChatCompletionsAgentStreamContext,
    mapChunk: ({ chunk, accumulator, context }) =>
      mapChatCompletionsAgentStreamChunk(chunk, accumulator, context),
    complete: options.complete,
    onError: (err) => [
      {
        type: 'turn_error',
        error: err instanceof Error ? err.message : options.fallbackErrorMessage,
      },
    ],
  });
}

function createChatCompletionsAgentStreamContext(): ChatCompletionsAgentStreamContext {
  return {};
}

function mapChatCompletionsAgentStreamChunk(
  rawChunk: unknown,
  accumulator: ChatCompletionsAccumulator,
  context: ChatCompletionsAgentStreamContext
): AgentEvent[] {
  const chunk = rawChunk as ChatCompletionsAgentStreamChunk;
  captureUsage(chunk.usage, context);

  const choice = chunk.choices?.[0];
  if (!choice) return [];

  const events = [...accumulator.addDelta(choice.delta as ChatCompletionsDelta)];
  if (choice.finish_reason) {
    events.push(...accumulator.finishToolCalls());
  }

  return events;
}

function captureUsage(
  usage: ChatCompletionsUsage | null | undefined,
  context: ChatCompletionsAgentStreamContext
): void {
  if (!usage) return;

  if (typeof usage.prompt_tokens === 'number') {
    context.providerReportedInputTokens = usage.prompt_tokens;
  }
  if (typeof usage.prompt_cache_hit_tokens === 'number') {
    context.promptCacheHitTokens = usage.prompt_cache_hit_tokens;
  }
  if (typeof usage.prompt_cache_miss_tokens === 'number') {
    context.promptCacheMissTokens = usage.prompt_cache_miss_tokens;
  }
}
