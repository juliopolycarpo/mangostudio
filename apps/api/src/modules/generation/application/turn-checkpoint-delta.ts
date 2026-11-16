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
  /** Grows by appending: only the characters past `length` are new. */
  | {
      readonly kind: 'text';
      readonly type: 'text' | 'thinking';
      readonly length: number;
      readonly flags: string;
    }
  /**
   * Written when the result arrives and replaced wholesale if it is upserted
   * again, never edited in place, so the same object means the same content
   * and nothing is read to decide.
   */
  | { readonly kind: 'result'; readonly part: MessagePart }
  /** Small and mutable (a call's lifecycle, a todo list): compared by value. */
  | { readonly kind: 'json'; readonly json: string };

interface PersistedState {
  readonly marks: PartMark[];
  readonly textLength: number;
  readonly providerState: string | null;
}

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
    return { kind: 'text', type: part.type, length: part.text.length, flags: textFlags(part) };
  }
  if (part.type === 'tool_result') {
    return { kind: 'result', part };
  }
  return { kind: 'json', json: json ?? JSON.stringify(toCheckpointPart(part)) };
}

/**
 * Turns the live turn state into the smallest write that keeps the store
 * equivalent to it: a delta against what the previous plan left behind, or a
 * rebase (the whole row) when there is nothing to diff against or the turn did
 * something other than grow.
 *
 * Planning is cheap on purpose. Text and thinking parts are only ever extended
 * (the stream appends to the trailing part), so they are compared by length and
 * flags. A tool result is written once and then skipped by identity without
 * reading it. Only the small parts that can change in place are serialized again.
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
      source.text.length < previous.textLength
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
          part.text.length >= mark.length
        ) {
          if (part.text.length > mark.length) {
            ops.push({ i, append: part.text.slice(mark.length) });
            marks[i] = { ...mark, length: part.text.length };
          }
          continue;
        }
      } else if (mark.kind === 'result') {
        if (part === mark.part) continue;
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
      providerState: source.providerState,
    };
    return { kind: 'rebase', partsJson: `[${serialized.join(',')}]` };
  }
}
