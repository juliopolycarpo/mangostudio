import { describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { mergeMessageParts } from '@mangostudio/shared/generation';
import {
  emitAgentStreamEvent,
  type StreamTextTurnSession,
} from '../../../../src/modules/generation/application/stream-text-turn-stages';
import type { StreamEvent } from '../../../../src/modules/generation/application/stream-text-turn-types';
import type { AgentEvent, ModelCapabilities } from '../../../../src/services/providers/types';

interface LoopStateStub {
  rawProviderState: string | null;
  pendingToolResults: undefined;
  isFirstIteration: boolean;
  inThinkingSegment: boolean;
  pendingCalls: Map<string, { name: string; argsStr: string }>;
  turnCompleted: boolean;
  degradedThisTurn: boolean;
}

function makeLoopState(): LoopStateStub {
  return {
    rawProviderState: null,
    pendingToolResults: undefined,
    isFirstIteration: true,
    inThinkingSegment: false,
    pendingCalls: new Map(),
    turnCompleted: false,
    degradedThisTurn: false,
  };
}

function makeSession(capabilities: ModelCapabilities): StreamTextTurnSession {
  return {
    allParts: [] as MessagePart[],
    fullText: '',
    chatId: 'chat-1',
    input: { chatId: 'chat-1', userId: 'user-1', prompt: 'Hi' },
    toolDefs: [],
    effectiveSystemPrompt: undefined,
    executionState: { durableProviderState: null, turnLocalState: null },
    checkpointWriter: {
      checkpoint: () => Promise.resolve(false),
    },
    provider: { providerType: 'gemini' },
    resolvedModel: { modelId: 'gemini-2.5-pro', capabilities },
  } as unknown as StreamTextTurnSession;
}

async function collect(
  session: StreamTextTurnSession,
  loop: LoopStateStub,
  events: AgentEvent[]
): Promise<StreamEvent[]> {
  const emitted: StreamEvent[] = [];
  for (const event of events) {
    // biome-ignore lint/suspicious/noExplicitAny: loop state is module-private
    for await (const out of emitAgentStreamEvent(session, event, loop as any, [])) {
      emitted.push(out);
    }
  }
  return emitted;
}

const GEMINI_CAPABILITIES: ModelCapabilities = {
  text: true,
  image: false,
  streaming: true,
  tools: true,
  internalAgentTools: false,
};

/**
 * Regression for the "one merge rule, three places" gap: a mid-reasoning
 * `continuation_degraded` left `loop.inThinkingSegment` stale, so the
 * `reasoning_delta` that resumed after it never re-announced `thinking_start`
 * — every other boundary (`tool_call_started`, `tool_result`,
 * `assistant_text_delta`, `turn_completed`) already resets the flag.
 *
 * `session.allParts` itself never diverges: it is append-only, and
 * `mergeMessageParts` on the persisted side merges by adjacency, so the
 * `continuation_transition` part pushed in between already keeps the two
 * reasoning runs apart on reload regardless of this flag. What the stale flag
 * breaks is the *live* SSE signal a client relies on to know a fresh segment
 * opened — see the frontend's `text-generation-stream-reducer.ts`, which no
 * longer needs that signal after being migrated onto the same structural rule,
 * but older clients (and the structural rule's own explicit-open path) do.
 */
describe('emitAgentStreamEvent — thinking segment across a continuation transition', () => {
  it('re-announces thinking_start after a mid-reasoning continuation_degraded', async () => {
    const session = makeSession(GEMINI_CAPABILITIES);
    const loop = makeLoopState();

    const emitted = await collect(session, loop, [
      { type: 'reasoning_delta', text: 'Checking the cursor.' },
      {
        type: 'continuation_degraded',
        from: 'interactions',
        to: 'replay',
        reason: 'interaction_expired',
        reasonCode: 'cursor_expired',
      },
      { type: 'reasoning_delta', text: 'Retrying from scratch.' },
    ]);

    expect(emitted.map((event) => event.type)).toEqual([
      'thinking_start',
      'thinking',
      'fallback_notice',
      'continuation_transition',
      'thinking_start',
      'thinking',
    ]);

    const persisted = mergeMessageParts(session.allParts);
    expect(persisted.filter((part) => part.type === 'thinking')).toEqual([
      { type: 'thinking', text: 'Checking the cursor.' },
      { type: 'thinking', text: 'Retrying from scratch.' },
    ]);
  });
});
