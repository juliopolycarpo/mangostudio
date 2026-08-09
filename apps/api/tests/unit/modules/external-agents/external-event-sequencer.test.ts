import { describe, expect, it } from 'bun:test';
import type { ExternalAgentEventEnvelope } from '@mangostudio/shared/external-agents';
import { ExternalEventSequencer } from '../../../../src/modules/external-agents/domain/external-event-sequencer';

function envelope(
  sequence: number,
  overrides: Partial<ExternalAgentEventEnvelope> = {}
): ExternalAgentEventEnvelope {
  return {
    sessionId: 'session-1',
    nativeTurnId: 'turn-1',
    sequence,
    emittedAtMs: sequence,
    event: { type: 'text_delta', text: `#${sequence}` },
    ...overrides,
  };
}

describe('ExternalEventSequencer', () => {
  it('applies events in order and advances the cursor', () => {
    const sequencer = new ExternalEventSequencer();
    sequencer.beginTurn('turn-1');

    expect(sequencer.admit(envelope(1)).kind).toBe('apply');
    expect(sequencer.admit(envelope(2)).kind).toBe('apply');
    expect(sequencer.lastAppliedSequence).toBe(2);
  });

  it('treats a repeated sequence as a no-op rather than an error', () => {
    const sequencer = new ExternalEventSequencer();
    sequencer.beginTurn('turn-1');
    sequencer.admit(envelope(1));

    expect(sequencer.admit(envelope(1)).kind).toBe('duplicate');
    expect(sequencer.lastAppliedSequence).toBe(1);
  });

  it('drops a stale event from before the cursor', () => {
    const sequencer = new ExternalEventSequencer(5);
    sequencer.beginTurn('turn-1');

    expect(sequencer.admit(envelope(3)).kind).toBe('duplicate');
    expect(sequencer.lastAppliedSequence).toBe(5);
  });

  it('reports a skipped sequence as loss, without advancing', () => {
    const sequencer = new ExternalEventSequencer();
    sequencer.beginTurn('turn-1');
    sequencer.admit(envelope(1));

    expect(sequencer.admit(envelope(3))).toEqual({ kind: 'gap', expected: 2, received: 3 });
    expect(sequencer.lastAppliedSequence).toBe(1);
  });

  it('deduplicates on an idempotency key the producer set', () => {
    const sequencer = new ExternalEventSequencer();
    sequencer.beginTurn('turn-1');
    sequencer.admit(envelope(1, { idempotencyKey: 'k1' }));

    expect(sequencer.admit(envelope(2, { idempotencyKey: 'k1' })).kind).toBe('duplicate');
  });

  it('advances past a key duplicate so the next event is not a false gap', () => {
    const sequencer = new ExternalEventSequencer();
    sequencer.beginTurn('turn-1');
    sequencer.admit(envelope(1, { idempotencyKey: 'k1' }));
    sequencer.admit(envelope(2, { idempotencyKey: 'k1' }));

    expect(sequencer.admit(envelope(3)).kind).toBe('apply');
  });

  it('drops events for a turn that already reached a terminal state', () => {
    const sequencer = new ExternalEventSequencer();
    sequencer.beginTurn('turn-1');
    sequencer.admit(envelope(1));
    sequencer.endTurn('turn-1');

    expect(sequencer.admit(envelope(2))).toEqual({
      kind: 'after-terminal',
      nativeTurnId: 'turn-1',
    });
  });

  it('keeps the cursor moving through dropped events so the next one is not a false gap', () => {
    const sequencer = new ExternalEventSequencer();
    sequencer.beginTurn('turn-1');
    sequencer.admit(envelope(1));
    sequencer.endTurn('turn-1');
    sequencer.admit(envelope(2));

    sequencer.beginTurn('turn-2');
    expect(sequencer.admit(envelope(3, { nativeTurnId: 'turn-2' })).kind).toBe('apply');
  });

  it('drops an event addressed to a different live turn', () => {
    const sequencer = new ExternalEventSequencer();
    sequencer.beginTurn('turn-2');

    expect(sequencer.admit(envelope(1, { nativeTurnId: 'turn-1' }))).toEqual({
      kind: 'foreign-turn',
      nativeTurnId: 'turn-1',
    });
  });

  it('admits events that arrive before the vendor has named the turn', () => {
    const sequencer = new ExternalEventSequencer();

    expect(sequencer.admit(envelope(1)).kind).toBe('apply');
  });
});
