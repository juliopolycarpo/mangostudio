/**
 * The planner decides, per checkpoint, between a delta and a rewrite of the
 * row. Whatever it picks, replaying its plans over an empty store must give
 * back the live turn, because that replay is what a reader or crash recovery
 * sees.
 */
import { describe, expect, it } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';

import { createTurnCheckpointPart } from '../../../../src/modules/generation/application/turn-checkpoint';
import {
  CheckpointPlanner,
  type CheckpointSource,
  holdBackHighSurrogate,
  toCheckpointPart,
} from '../../../../src/modules/generation/application/turn-checkpoint-delta';
import {
  type CheckpointDelta,
  type CheckpointedContent,
  foldCheckpointDeltas,
} from '../../../../src/modules/messages/infrastructure/message-checkpoint-deltas';

/** A store that applies plans the way the database does: a rebase replaces, a delta folds. */
class ReplayedStore {
  content: CheckpointedContent = { text: '', parts: [], providerState: null, generationTime: null };
  rebases = 0;
  deltaChars = 0;
  rebaseChars = 0;

  apply(plan: ReturnType<CheckpointPlanner['plan']>, source: CheckpointSource): void {
    if (plan.kind === 'rebase') {
      this.rebases++;
      this.rebaseChars += plan.partsJson.length;
      this.content = {
        text: plan.text,
        parts: JSON.parse(plan.partsJson) as MessagePart[],
        providerState: source.providerState,
        generationTime: source.generationTime ?? null,
      };
      return;
    }
    this.deltaChars += plan.deltaJson.length;
    this.content = foldCheckpointDeltas(this.content, [
      JSON.parse(plan.deltaJson) as CheckpointDelta,
    ]);
  }
}

function newTurn() {
  const checkpoint = createTurnCheckpointPart({
    turnId: 'turn',
    startedAt: 0,
    provider: 'openai',
    modelName: 'gpt-test',
    agentId: 'default',
  });
  const parts: MessagePart[] = [checkpoint];
  const live = { text: '', providerState: null as string | null, parts };
  return { checkpoint, parts, live };
}

const expectStoreMatchesLive = (store: ReplayedStore, live: CheckpointSource): void => {
  expect(store.content.text).toBe(live.text);
  expect(store.content.parts).toEqual(live.parts.map(toCheckpointPart));
  expect(store.content.providerState).toBe(live.providerState);
};

describe('CheckpointPlanner', () => {
  it('rebases first, then plans deltas that replay to the live turn', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    const kinds: string[] = [];
    const checkpoint = () => {
      const plan = planner.plan(live);
      kinds.push(plan.kind);
      store.apply(plan, live);
      expectStoreMatchesLive(store, live);
    };

    checkpoint();
    parts.push({ type: 'thinking', text: 'think' });
    (parts[1] as { text: string }).text += 'ing';
    checkpoint();
    parts.push({ type: 'text', text: 'Let me look.' });
    live.text = 'Let me look.';
    checkpoint();
    (parts[2] as { text: string }).text += ' Found it.';
    live.text += ' Found it.';
    checkpoint();
    parts.push({ type: 'tool_call', toolCallId: 'c1', name: 'grep', args: { q: 'x' } });
    checkpoint();
    parts.push({ type: 'tool_result', toolCallId: 'c1', content: 'r'.repeat(40_000) });
    live.providerState = '{"cursor":1}';
    checkpoint();
    checkpoint();

    expect(kinds).toEqual(['rebase', 'delta', 'delta', 'delta', 'delta', 'delta', 'delta']);
  });

  it('writes a tool result once and never again however many checkpoints follow', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    store.apply(planner.plan(live), live);
    const resultLength = 30_000;

    for (let call = 0; call < 20; call++) {
      parts.push({ type: 'tool_call', toolCallId: `c${call}`, name: 'read_file', args: {} });
      store.apply(planner.plan(live), live);
      parts.push({
        type: 'tool_result',
        toolCallId: `c${call}`,
        content: 'r'.repeat(resultLength),
      });
      store.apply(planner.plan(live), live);
    }

    expectStoreMatchesLive(store, live);
    // 20 results are 600,000 characters; each delta that follows one must not carry it again.
    expect(store.deltaChars).toBeGreaterThanOrEqual(20 * resultLength);
    expect(store.deltaChars).toBeLessThan(20 * resultLength + 40 * 1_000);
  });

  it('carries only the new text when an answer grows', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    parts.push({ type: 'text', text: '' });
    store.apply(planner.plan(live), live);

    let written = 0;
    for (let step = 0; step < 100; step++) {
      (parts[1] as { text: string }).text += 'a'.repeat(512);
      live.text += 'a'.repeat(512);
      const before = store.deltaChars;
      store.apply(planner.plan(live), live);
      written += store.deltaChars - before;
    }

    expectStoreMatchesLive(store, live);
    // 51,200 characters of answer, held twice (message text and part), plus the envelope.
    expect(written).toBeLessThan(2 * 51_200 + 100 * 200);
  });

  it('writes a part whose state moved in place, such as a call changing status', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    parts.push({ type: 'tool_call', toolCallId: 'c1', name: 'run_shell', args: { cmd: 'ls' } });
    store.apply(planner.plan(live), live);

    parts[1] = { type: 'tool_call', toolCallId: 'c1', name: 'run_shell', args: { cmd: 'ls -l' } };
    store.apply(planner.plan(live), live);

    expectStoreMatchesLive(store, live);
    expect(store.rebases).toBe(1);
  });

  it('writes a tool result that is upserted again, even at the same length', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    parts.push({ type: 'tool_result', toolCallId: 'c1', content: 'first' });
    store.apply(planner.plan(live), live);

    // `upsertToolResultPart` replaces the object; content length and id do not change.
    parts[1] = { type: 'tool_result', toolCallId: 'c1', content: 'other', isError: true };
    store.apply(planner.plan(live), live);

    expectStoreMatchesLive(store, live);
  });

  it('does not write a tool result again when it is upserted as an equal copy', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    const content = 'r'.repeat(40_000);
    parts.push({ type: 'tool_result', toolCallId: 'c1', content });
    store.apply(planner.plan(live), live);
    const before = store.deltaChars;

    // A mixed image batch upserts the same result again as a new object.
    parts[1] = {
      type: 'tool_result',
      toolCallId: 'c1',
      content: `${content.slice(0, 20_000)}${content.slice(20_000)}`,
    };
    store.apply(planner.plan(live), live);

    expectStoreMatchesLive(store, live);
    expect(store.deltaChars - before).toBeLessThan(200);
  });

  it('still notices a changed result after an equal copy replaced the one it holds', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    const content = 'r'.repeat(40_000);
    parts.push({ type: 'tool_result', toolCallId: 'c1', content });
    store.apply(planner.plan(live), live);

    // The planner refreshes its mark to the new string object on an equal match; string
    // identity is not observable from here, so this pins that the refresh keeps the value.
    parts[1] = { type: 'tool_result', toolCallId: 'c1', content: `${content}` };
    store.apply(planner.plan(live), live);
    const afterCopy = store.deltaChars;
    parts[1] = { type: 'tool_result', toolCallId: 'c1', content: `${content}`.slice(0, 39_999) };
    store.apply(planner.plan(live), live);

    expectStoreMatchesLive(store, live);
    expect(store.deltaChars - afterCopy).toBeGreaterThan(39_000);
  });

  it('writes a text part whose stored prefix changed, though its length did not', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    parts.push({ type: 'text', text: 'The quick brown fox jumps over the lazy dog' });
    live.text = 'The quick brown fox jumps over the lazy dog';
    store.apply(planner.plan(live), live);

    // Rewritten in place: same length, new ending. Appending nothing would lose the edit.
    parts[1] = { type: 'text', text: 'The quick brown fox jumps over the lazy cat' };
    live.text = 'The quick brown fox jumps over the lazy cat';
    store.apply(planner.plan(live), live);

    expectStoreMatchesLive(store, live);
  });

  it('rebases when the message text no longer starts with what was stored', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    parts.push({ type: 'text', text: 'first draft of the reply' });
    live.text = 'first draft of the reply';
    store.apply(planner.plan(live), live);

    parts[1] = { type: 'text', text: 'second draft of the reply, longer' };
    live.text = 'second draft of the reply, longer';
    const plan = planner.plan(live);
    store.apply(plan, live);

    expect(plan.kind).toBe('rebase');
    expectStoreMatchesLive(store, live);
  });

  it('carries a thinking part that becomes redacted or incomplete without growing', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    parts.push({ type: 'thinking', text: 'abc' });
    store.apply(planner.plan(live), live);

    (parts[1] as { incomplete?: true }).incomplete = true;
    store.apply(planner.plan(live), live);

    expectStoreMatchesLive(store, live);
    expect(store.content.parts[1]).toEqual({ type: 'thinking', text: 'abc', incomplete: true });
  });

  it('carries a status change on the turn checkpoint but not its derived summary', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { checkpoint, live } = newTurn();
    store.apply(planner.plan(live), live);

    checkpoint.status = 'interrupted';
    checkpoint.lastAssistantText = 'derived '.repeat(1_000);
    store.apply(planner.plan(live), live);

    const stored = store.content.parts[0];
    expect(stored).toMatchObject({ type: 'turn_checkpoint', status: 'interrupted' });
    expect(stored).toMatchObject({ lastAssistantText: '', completedCalls: [] });
  });

  it('rebases when the turn shrinks, as it does when the model restarts an answer', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    parts.push({ type: 'text', text: 'draft draft' });
    live.text = 'draft draft';
    store.apply(planner.plan(live), live);

    parts[1] = { type: 'text', text: 'new' };
    live.text = 'new';
    const plan = planner.plan(live);
    store.apply(plan, live);

    expect(plan.kind).toBe('rebase');
    expectStoreMatchesLive(store, live);
  });

  it('writes a replaced text part in full when it is not an extension of the stored one', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    parts.push({ type: 'text', text: 'abc' });
    live.text = 'abc';
    store.apply(planner.plan(live), live);

    parts[1] = { type: 'thinking', text: 'abcdef' };
    store.apply(planner.plan(live), live);

    expectStoreMatchesLive(store, live);
  });

  it('rebases after reset, so a write that never landed leaves no gap', () => {
    const planner = new CheckpointPlanner();
    const { parts, live } = newTurn();
    planner.plan(live);
    parts.push({ type: 'text', text: 'a' });
    planner.plan(live);

    planner.reset();
    parts.push({ type: 'text', text: 'b' });

    expect(planner.plan(live).kind).toBe('rebase');
  });
});

// Escapes are written as code unit numbers, so no lone surrogate sits in this file's source.
const HIGH_HALF = String.fromCharCode(0xd83d);
const LOW_HALF = String.fromCharCode(0xde00);
const GRINNING_FACE = `${HIGH_HALF}${LOW_HALF}`;

describe('holdBackHighSurrogate', () => {
  it('drops a trailing high surrogate and nothing else', () => {
    expect({
      split: holdBackHighSurrogate(`ab${HIGH_HALF}`),
      whole: holdBackHighSurrogate(`ab${GRINNING_FACE}`),
      plain: holdBackHighSurrogate('ab'),
      empty: holdBackHighSurrogate(''),
      onlyHalf: holdBackHighSurrogate(HIGH_HALF),
      trailingLow: holdBackHighSurrogate(`ab${LOW_HALF}`),
    }).toEqual({
      split: 'ab',
      whole: `ab${GRINNING_FACE}`,
      plain: 'ab',
      empty: '',
      onlyHalf: '',
      trailingLow: `ab${LOW_HALF}`,
    });
  });
});

describe('CheckpointPlanner and a character the stream has delivered half of', () => {
  it('holds the half back from a rebase and sends the whole pair with the next delta', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    live.text = `hi ${HIGH_HALF}`;
    parts.push({ type: 'text', text: live.text });

    const first = planner.plan(live);
    store.apply(first, live);
    const heldBack = { text: store.content.text, part: store.content.parts[1] };

    live.text = `hi ${GRINNING_FACE} there`;
    parts[1] = { type: 'text', text: live.text };
    store.apply(planner.plan(live), live);

    expect({ first: first.kind, heldBack, after: store.content.text }).toEqual({
      first: 'rebase',
      heldBack: { text: 'hi ', part: { type: 'text', text: 'hi ' } },
      after: live.text,
    });
    expectStoreMatchesLive(store, live);
  });

  it('holds the half back from a delta, in the message text and in the text part alike', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    live.text = 'hi ';
    parts.push({ type: 'text', text: 'hi ' });
    store.apply(planner.plan(live), live);

    live.text = `hi ${HIGH_HALF}`;
    parts[1] = { type: 'text', text: live.text };
    const split = planner.plan(live);
    store.apply(split, live);
    const heldBack = { text: store.content.text, part: store.content.parts[1] };
    live.text = `hi ${GRINNING_FACE}`;
    parts[1] = { type: 'text', text: live.text };
    store.apply(planner.plan(live), live);

    expect({ kind: split.kind, heldBack, after: store.content.text }).toEqual({
      kind: 'delta',
      heldBack: { text: 'hi ', part: { type: 'text', text: 'hi ' } },
      after: live.text,
    });
    expectStoreMatchesLive(store, live);
  });

  it('holds back a thinking part that ends in half a pair', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    parts.push({ type: 'thinking', text: `hm ${HIGH_HALF}` });

    store.apply(planner.plan(live), live);

    expect(store.content.parts[1]).toEqual({ type: 'thinking', text: 'hm ' });
  });

  it('never gives the store a lone surrogate while the stream splits pairs at every offset', () => {
    const planner = new CheckpointPlanner();
    const store = new ReplayedStore();
    const { parts, live } = newTurn();
    parts.push({ type: 'text', text: '' });
    const stream = `a${GRINNING_FACE}é${GRINNING_FACE}${GRINNING_FACE}z`;

    for (let end = 1; end <= stream.length; end++) {
      live.text = stream.slice(0, end);
      parts[1] = { type: 'text', text: live.text };
      store.apply(planner.plan(live), live);
      expect(store.content.text).toBe(stream.slice(0, end).replace(/[\uD800-\uDBFF]$/, ''));
    }
    expectStoreMatchesLive(store, live);
  });
});
