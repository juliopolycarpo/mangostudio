import { describe, expect, it } from 'bun:test';
import type { Message } from '@mangostudio/shared';
import type { TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import { findLatestInterruptedTurn } from '@/features/chat/lib/interrupted-turn';

const CHECKPOINT: TurnCheckpointPart = {
  type: 'turn_checkpoint',
  version: 1,
  turnId: 'turn-1',
  status: 'interrupted',
  reasonCode: 'server_restart',
  sequence: 3,
  startedAt: 1,
  checkpointedAt: 2,
  provider: 'openai',
  modelName: 'gpt-test',
  agentId: 'default',
  lastAssistantText: 'partial response',
  todoSnapshot: [],
  completedCalls: [],
  incompleteCalls: [],
};

function message(index: number, overrides: Partial<Message> = {}): Message {
  const role = index % 2 === 0 ? 'user' : 'ai';
  return {
    id: `message-${index}`,
    chatId: 'chat-1',
    role,
    text: `text ${index}`,
    timestamp: index,
    parts: [{ type: 'text', text: `text ${index}` }],
    ...overrides,
  };
}

/** A user/ai transcript of `length` messages, ai on the odd indices. */
function transcript(length: number): Message[] {
  return Array.from({ length }, (_, index) => message(index));
}

/** Rebuilds `base` with `parts` behind a getter that counts every read. */
function countingParts(base: Message, counter: { reads: number }): Message {
  const { parts, ...rest } = base;
  const wrapped = rest as Message;
  Object.defineProperty(wrapped, 'parts', {
    get() {
      counter.reads += 1;
      return parts;
    },
    enumerable: true,
    configurable: true,
  });
  return wrapped;
}

describe('findLatestInterruptedTurn', () => {
  it('returns null across a long transcript with no interrupted turn', () => {
    expect(findLatestInterruptedTurn(transcript(500))).toBeNull();
  });

  it('returns the newest interrupted checkpoint when several exist', () => {
    const messages = transcript(500);
    messages[101] = message(101, { parts: [{ ...CHECKPOINT, turnId: 'older' }] });
    messages[301] = message(301, { parts: [{ ...CHECKPOINT, turnId: 'newer' }] });

    const found = findLatestInterruptedTurn(messages);

    expect(found?.messageId).toBe('message-301');
    expect(found?.checkpoint.turnId).toBe('newer');
  });

  it('ignores checkpoints that are resumed or dismissed', () => {
    const messages = transcript(10);
    messages[9] = message(9, {
      role: 'ai',
      parts: [{ ...CHECKPOINT, status: 'resumed' }],
    });

    expect(findLatestInterruptedTurn(messages)).toBeNull();
  });

  it('rejects a part that claims interruption but fails schema validation', () => {
    const messages = transcript(10);
    messages[9] = message(9, {
      role: 'ai',
      parts: [{ type: 'turn_checkpoint', status: 'interrupted' } as never],
    });

    expect(findLatestInterruptedTurn(messages)).toBeNull();
  });

  it('detects a checkpoint landing on the existing tail message mid-stream', () => {
    // The interruption path patches the checkpoint part onto the message that
    // was already streaming: same id, same transcript length, new object. A
    // cache keyed on id + length instead of object identity misses exactly this.
    const messages = transcript(500);
    expect(findLatestInterruptedTurn(messages)).toBeNull();

    const tail = messages[499] as Message;
    const interrupted = [...messages.slice(0, 499), { ...tail, parts: [CHECKPOINT] }];

    expect(findLatestInterruptedTurn(interrupted)?.messageId).toBe(tail.id);
  });

  it('re-examines only the replaced message on a streaming delta', () => {
    const counter = { reads: 0 };
    const messages = transcript(500).map((entry) => countingParts(entry, counter));
    const aiMessages = messages.filter((entry) => entry.role === 'ai').length;

    expect(findLatestInterruptedTurn(messages)).toBeNull();
    expect(counter.reads).toBe(aiMessages);

    // A delta replaces the streamed message and keeps every other identity,
    // mirroring `updateOptimisticMessage`.
    const tail = messages[499] as Message;
    const next = [
      ...messages.slice(0, 499),
      countingParts(message(499, { text: `${tail.text} more` }), counter),
    ];

    expect(findLatestInterruptedTurn(next)).toBeNull();
    expect(counter.reads).toBe(aiMessages + 1);
  });
});
