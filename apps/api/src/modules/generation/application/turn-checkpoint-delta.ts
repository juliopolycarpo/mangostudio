import type { MessagePart } from '@mangostudio/shared/types';

import type {
  CheckpointDelta,
  CheckpointPartOp,
} from '../../messages/infrastructure/message-checkpoint-deltas';

/** The turn state a checkpoint persists. `parts` is the live array. */
export interface CheckpointSource {
  readonly text: string;
  readonly parts: readonly MessagePart[];
  readonly providerState: string | null;
  readonly generationTime?: string | null;
}

export type CheckpointPlan =
  /** The whole row, because the change is not expressible as a delta. */
  | { readonly kind: 'rebase'; readonly partsJson: string }
  | { readonly kind: 'delta'; readonly deltaJson: string };

/** What the store holds for one part, enough to tell what changed without re-reading it. */
type PartMark =
  /**
   * Grows by appending: only the characters past `length` are new. `tail` is the
   * last few stored characters, so a part that was rewritten rather than
   * extended is noticed without comparing the whole text.
   */
  | {
      readonly kind: 'text';
      readonly type: 'text' | 'thinking';
      readonly length: number;
      readonly tail: string;
      readonly flags: string;
    }
  /**
   * Written when the result arrives. The content string is held by reference:
   * a result that is upserted again with the same content (the stream does this
   * for mixed image batches) compares equal in constant time when it is the same
   * string, and a changed one is written again.
   */
  | {
      readonly kind: 'result';
      readonly toolCallId: string;
      readonly content: string;
      readonly isError: boolean | undefined;
    }
  /** Small and mutable (a call's lifecycle, a todo list): compared by value. */
  | { readonly kind: 'json'; readonly json: string };

interface PersistedState {
  readonly marks: PartMark[];
  readonly textLength: number;
  readonly textTail: string;
  readonly providerState: string | null;
}

/** Characters of a text's end kept to check that what was stored is still its prefix. */
const TAIL_CHARS = 32;

const tailOf = (text: string, length = text.length): string =>
  text.slice(Math.max(0, length - TAIL_CHARS), length);

/** Whether `text` still begins with what was stored: its first `length` characters end in `tail`. */
const endsStoredPrefixWith = (text: string, length: number, tail: string): boolean =>
  text.length >= length && tailOf(text, length) === tail;

/**
 * The part as a checkpoint stores it. The recovery summary on the turn
 * checkpoint (`lastAssistantText`, `completedCalls`, ...) is derived from the
 * text and parts, and crash reconciliation derives it again from the folded
 * message, so persisting it at every checkpoint would repeat the answer's last
 * 8,000 characters and up to 50 tool results each time.
 */
export function toCheckpointPart(part: MessagePart): MessagePart {
  if (part.type !== 'turn_checkpoint') return part;
  return {
    ...part,
    lastAssistantText: '',
    todoSnapshot: [],
    completedCalls: [],
    incompleteCalls: [],
  };
}

function textFlags(part: Extract<MessagePart, { type: 'text' | 'thinking' }>): string {
  const redacted = part.type === 'thinking' && part.redacted ? 'r' : '';
  return `${redacted}${part.incomplete ? 'i' : ''}`;
}

function markPart(part: MessagePart, json?: string): PartMark {
  if (part.type === 'text' || part.type === 'thinking') {
    return {
      kind: 'text',
      type: part.type,
      length: part.text.length,
      tail: tailOf(part.text),
      flags: textFlags(part),
    };
  }
  if (part.type === 'tool_result') {
    return {
      kind: 'result',
      toolCallId: part.toolCallId,
      content: part.content,
      isError: part.isError,
    };
  }
  return { kind: 'json', json: json ?? JSON.stringify(toCheckpointPart(part)) };
}

/**
 * Turns the live turn state into the smallest write that keeps the store
 * equivalent to it: a delta against what the previous plan left behind, or a
 * rebase (the whole row) when there is nothing to diff against or the turn did
 * something other than grow.
 *
 * Planning is cheap on purpose, so it leans on how the stream builds a turn:
 * text and thinking parts only grow (the stream appends to the trailing part),
 * and a tool result is set once, or replaced whole. Each assumption is checked
 * where that is cheap (a text part must still end its stored prefix with the same
 * characters, a result must still hold the same string) and the plan falls back
 * to writing the part, or the row, when it does not. A change the checks cannot
 * see, such as an edit in the middle of a long text, is what the differential
 * test (`turn-checkpoint-differential.test.ts`) guards. Only the small parts
 * that can change in place are serialized again.
 *
 * Plans assume they are written in order. After a failed write, call
 * {@link reset}: the next plan is then a rebase, which does not depend on any
 * earlier plan having landed.
 */
export class CheckpointPlanner {
  private persisted: PersistedState | null = null;

  plan(source: CheckpointSource): CheckpointPlan {
    const previous = this.persisted;
    if (
      !previous ||
      source.parts.length < previous.marks.length ||
      !endsStoredPrefixWith(source.text, previous.textLength, previous.textTail)
    ) {
      return this.rebase(source);
    }

    const marks = [...previous.marks];
    const ops: CheckpointPartOp[] = [];
    for (let i = 0; i < source.parts.length; i++) {
      const part = source.parts[i] as MessagePart;
      const mark = previous.marks[i];
      if (!mark) {
        ops.push({ i, part: toCheckpointPart(part) });
        marks[i] = markPart(part);
        continue;
      }
      if (mark.kind === 'text') {
        if (
          (part.type === 'text' || part.type === 'thinking') &&
          part.type === mark.type &&
          textFlags(part) === mark.flags &&
          endsStoredPrefixWith(part.text, mark.length, mark.tail)
        ) {
          if (part.text.length > mark.length) {
            ops.push({ i, append: part.text.slice(mark.length) });
            marks[i] = { ...mark, length: part.text.length, tail: tailOf(part.text) };
          }
          continue;
        }
      } else if (mark.kind === 'result') {
        if (
          part.type === 'tool_result' &&
          part.toolCallId === mark.toolCallId &&
          part.isError === mark.isError &&
          part.content === mark.content
        ) {
          continue;
        }
      } else {
        const json = JSON.stringify(toCheckpointPart(part));
        if (json === mark.json) continue;
        ops.push({ i, part: toCheckpointPart(part) });
        marks[i] = { kind: 'json', json };
        continue;
      }
      ops.push({ i, part: toCheckpointPart(part) });
      marks[i] = markPart(part);
    }

    const delta: CheckpointDelta = {
      ...(source.text.length > previous.textLength
        ? { text: source.text.slice(previous.textLength) }
        : {}),
      ...(ops.length > 0 ? { ops } : {}),
      ...(source.providerState === previous.providerState
        ? {}
        : { providerState: source.providerState }),
      ...(source.generationTime === undefined ? {} : { generationTime: source.generationTime }),
    };
    this.persisted = {
      marks,
      textLength: source.text.length,
      textTail: tailOf(source.text),
      providerState: source.providerState,
    };
    return { kind: 'delta', deltaJson: JSON.stringify(delta) };
  }

  /** Forgets what the store holds, so the next plan rewrites the row. */
  reset(): void {
    this.persisted = null;
  }

  private rebase(source: CheckpointSource): CheckpointPlan {
    const serialized = source.parts.map((part) => JSON.stringify(toCheckpointPart(part)));
    this.persisted = {
      marks: source.parts.map((part, index) => markPart(part, serialized[index])),
      textLength: source.text.length,
      textTail: tailOf(source.text),
      providerState: source.providerState,
    };
    return { kind: 'rebase', partsJson: `[${serialized.join(',')}]` };
  }
}
