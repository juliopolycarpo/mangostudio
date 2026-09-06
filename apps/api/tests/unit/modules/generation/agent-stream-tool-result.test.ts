import { describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
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
    provider: { providerType: 'cursor' },
    resolvedModel: { modelId: 'composer-2.5', capabilities },
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

const INTERNAL_TOOL_LOOP_CAPABILITIES: ModelCapabilities = {
  text: true,
  image: false,
  streaming: true,
  tools: true,
  internalAgentTools: true,
};

describe('emitAgentStreamEvent — provider-supplied tool_result', () => {
  it('marks the pending call satisfied and persists tool_call/tool_result parts', async () => {
    const session = makeSession(INTERNAL_TOOL_LOOP_CAPABILITIES);
    const loop = makeLoopState();

    const emitted = await collect(session, loop, [
      { type: 'tool_call_started', callId: 'call-1', name: 'bash' },
      { type: 'tool_call_completed', callId: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' },
      { type: 'tool_result', callId: 'call-1', name: 'bash', result: 'src\n', isError: false },
    ]);

    expect(loop.pendingCalls.size).toBe(0);
    expect(session.allParts).toEqual([
      { type: 'tool_call', toolCallId: 'call-1', name: 'bash', args: { cmd: 'ls' } },
      { type: 'tool_result', toolCallId: 'call-1', content: 'src\n', isError: false },
    ]);
    expect(emitted).toContainEqual({
      type: 'tool_result',
      callId: 'call-1',
      name: 'bash',
      result: 'src\n',
      isError: false,
    });
  });

  it('persists a tool_result part even when no pending call matches', async () => {
    const session = makeSession(INTERNAL_TOOL_LOOP_CAPABILITIES);
    const loop = makeLoopState();

    const emitted = await collect(session, loop, [
      { type: 'tool_result', callId: 'orphan', name: 'bash', result: { ok: true }, isError: true },
    ]);

    expect(session.allParts).toEqual([
      { type: 'tool_result', toolCallId: 'orphan', content: '{"ok":true}', isError: true },
    ]);
    expect(emitted).toHaveLength(1);
  });

  it('ignores tool_result events from providers without internalAgentTools', async () => {
    const session = makeSession({ ...INTERNAL_TOOL_LOOP_CAPABILITIES, internalAgentTools: false });
    const loop = makeLoopState();

    const emitted = await collect(session, loop, [
      { type: 'tool_call_started', callId: 'call-1', name: 'bash' },
      { type: 'tool_call_completed', callId: 'call-1', name: 'bash', arguments: '{}' },
      { type: 'tool_result', callId: 'call-1', name: 'bash', result: 'x', isError: false },
    ]);

    expect(loop.pendingCalls.size).toBe(1);
    expect(session.allParts).toEqual([
      { type: 'tool_call', toolCallId: 'call-1', name: 'bash', args: {} },
    ]);
    expect(emitted.filter((event) => event.type === 'tool_result')).toEqual([]);
  });
});
