/**
 * A streaming turn keeps its parts merged as deltas arrive, so the in-flight
 * row holds one part per text or reasoning run instead of one per delta. Every
 * checkpoint serializes all of the turn's parts, so a part per delta made each
 * write grow with the delta count rather than the answer length.
 *
 * The SSE stream and the finalized parts must not change: each delta still
 * yields its own event, and `mergeMessageParts` of the merged parts is
 * byte-identical to `mergeMessageParts` of one part per delta.
 */
import { describe, expect, it } from 'bun:test';

import { mergeMessageParts } from '@mangostudio/shared/generation';
import type { MessagePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';

import type { Database } from '../../../../src/db/types';
import {
  emitAgentStreamEvent,
  type StreamTextTurnSession,
} from '../../../../src/modules/generation/application/stream-text-turn-stages';
import type { StreamEvent } from '../../../../src/modules/generation/application/stream-text-turn-types';
import {
  createTurnCheckpointPart,
  TurnCheckpointWriter,
} from '../../../../src/modules/generation/application/turn-checkpoint';
import type { AgentEvent, ModelCapabilities } from '../../../../src/services/providers/types';

const CAPABILITIES: ModelCapabilities = {
  text: true,
  image: false,
  streaming: true,
  tools: true,
  internalAgentTools: false,
};

interface RecordedCheckpointWrite {
  readonly textBytes: number;
  readonly partsBytes: number;
  readonly partCount: number;
}

/** Named fake for the `messages` checkpoint update: records each row it would write. */
class RecordingCheckpointDb {
  readonly writes: RecordedCheckpointWrite[] = [];

  asKysely(): Kysely<Database> {
    return this as unknown as Kysely<Database>;
  }

  updateTable(table: string) {
    if (table !== 'messages') throw new Error(`expected table: messages | received: ${table}`);
    let values = { text: '', parts: '[]' };
    const update = {
      set: (next: { text: string; parts: string }) => {
        values = next;
        return update;
      },
      where: () => update,
      execute: () => {
        this.writes.push({
          textBytes: values.text.length,
          partsBytes: values.parts.length,
          partCount: (JSON.parse(values.parts) as MessagePart[]).length,
        });
        return Promise.resolve();
      },
    };
    return update;
  }
}

function makeLoopState() {
  return {
    rawProviderState: null,
    pendingToolResults: undefined,
    isFirstIteration: true,
    inThinkingSegment: false,
    pendingCalls: new Map<string, { name: string; argsStr: string }>(),
    turnCompleted: false,
    degradedThisTurn: false,
  };
}

function makeSession(): StreamTextTurnSession {
  return {
    allParts: [] as MessagePart[],
    fullText: '',
    chatId: 'chat-merged-parts',
    input: { chatId: 'chat-merged-parts', userId: 'user-1', prompt: 'Hi' },
    toolDefs: [],
    effectiveSystemPrompt: undefined,
    executionState: { durableProviderState: null, turnLocalState: null },
    checkpointWriter: { checkpoint: () => Promise.resolve(false) },
    provider: { providerType: 'gemini' },
    resolvedModel: { modelId: 'gemini-2.5-pro', capabilities: CAPABILITIES },
  } as unknown as StreamTextTurnSession;
}

async function emitAll(
  session: StreamTextTurnSession,
  events: AgentEvent[]
): Promise<StreamEvent[]> {
  const loop = makeLoopState();
  const emitted: StreamEvent[] = [];
  for (const event of events) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loop state is module-private
    for await (const out of emitAgentStreamEvent(session, event, loop as any, [])) {
      emitted.push(out);
    }
  }
  return emitted;
}

/** The parts the agent path built before it merged at push time: one per delta. */
function unmergedAgentParts(events: AgentEvent[]): MessagePart[] {
  return events.flatMap((event): MessagePart[] => {
    if (event.type === 'reasoning_delta') return [{ type: 'thinking', text: event.text }];
    if (event.type === 'assistant_text_delta') return [{ type: 'text', text: event.text }];
    if (event.type === 'tool_call_started') {
      return [{ type: 'tool_call', toolCallId: event.callId, name: event.name ?? '', args: {} }];
    }
    return [];
  });
}

function textDeltas(count: number, chunk = 'abcd'): AgentEvent[] {
  return Array.from({ length: count }, () => ({ type: 'assistant_text_delta', text: chunk }));
}

describe('emitAgentStreamEvent — streamed deltas extend the trailing part', () => {
  it('holds one text part after 4,096 text deltas', async () => {
    const session = makeSession();
    const emitted = await emitAll(session, textDeltas(4_096));

    expect(session.allParts).toHaveLength(1);
    expect(session.allParts[0]).toEqual({ type: 'text', text: 'abcd'.repeat(4_096) });
    // Each delta still reaches the client as its own SSE event.
    expect(emitted.filter((event) => event.type === 'text')).toHaveLength(4_096);
  });

  it('keeps one part per run across reasoning, a tool call and a continuation transition', async () => {
    const session = makeSession();
    const events: AgentEvent[] = [
      { type: 'reasoning_delta', text: 'Think ' },
      { type: 'reasoning_delta', text: 'twice.' },
      { type: 'assistant_text_delta', text: 'Let me ' },
      { type: 'assistant_text_delta', text: 'look.' },
      { type: 'tool_call_started', callId: 'call-1', name: 'grep' },
      { type: 'assistant_text_delta', text: 'Found ' },
      { type: 'assistant_text_delta', text: 'it.' },
      {
        type: 'continuation_degraded',
        from: 'interactions',
        to: 'replay',
        reason: 'interaction_expired',
        reasonCode: 'cursor_expired',
      },
      { type: 'reasoning_delta', text: 'Again.' },
      { type: 'assistant_text_delta', text: 'Done.' },
    ];

    await emitAll(session, events);

    expect(session.allParts.map((part) => part.type)).toEqual([
      'thinking',
      'text',
      'tool_call',
      'text',
      'continuation_transition',
      'thinking',
      'text',
    ]);
    expect(session.allParts[0]).toEqual({ type: 'thinking', text: 'Think twice.' });
    expect(session.allParts[3]).toEqual({ type: 'text', text: 'Found it.' });
    expect(JSON.stringify(mergeMessageParts(session.allParts))).toBe(
      JSON.stringify(session.allParts)
    );
  });

  it('finalizes to the same bytes as one part per delta', async () => {
    const session = makeSession();
    const events: AgentEvent[] = [
      { type: 'reasoning_delta', text: 'Plan.' },
      ...textDeltas(64, 'ab'),
      { type: 'assistant_text_delta', text: '' },
      { type: 'tool_call_started', callId: 'call-1', name: 'read_file' },
      { type: 'reasoning_delta', text: 'Read it.' },
      ...textDeltas(64, 'cd'),
    ];

    await emitAll(session, events);

    expect(JSON.stringify(mergeMessageParts(session.allParts))).toBe(
      JSON.stringify(mergeMessageParts(unmergedAgentParts(events)))
    );
  });
});

describe('emitAgentStreamEvent — checkpoint size with merged parts', () => {
  it('writes each checkpoint at about the size of the answer so far', async () => {
    const db = new RecordingCheckpointDb();
    const session = makeSession();
    const checkpoint = createTurnCheckpointPart({
      turnId: 'turn-merged-parts',
      startedAt: 0,
      provider: 'gemini',
      modelName: 'gemini-2.5-pro',
      agentId: 'default',
    });
    session.allParts.push(checkpoint);
    session.checkpointWriter = new TurnCheckpointWriter({
      db: db.asKysely(),
      chatId: session.chatId,
      messageId: 'turn-merged-parts',
      checkpoint,
      getContent: () => ({ text: session.fullText, parts: session.allParts, providerState: null }),
      now: () => 0,
      defer: (run) => run(),
    });

    // 16,384 deltas of 4 characters: a 64K-character answer.
    await emitAll(session, textDeltas(16_384));
    await session.checkpointWriter.flush();

    const last = db.writes.at(-1);
    expect(db.writes).toHaveLength(128);
    expect(last).toMatchObject({ textBytes: 65_536, partCount: 2 });
    // Characters handed to the row update over the whole turn: 9.46M with
    // merged parts, 36.93M with one part per delta.
    const turnChars = db.writes.reduce((sum, write) => sum + write.textBytes + write.partsBytes, 0);
    expect(turnChars).toBeLessThan(10_000_000);
    // Parts carry the answer once plus the checkpoint summary, which keeps at
    // most 8,000 characters of trailing text, plus fixed JSON overhead.
    for (const write of db.writes) {
      expect(write.partsBytes).toBeLessThan(write.textBytes + 8_000 + 1_024);
    }
  });
});
