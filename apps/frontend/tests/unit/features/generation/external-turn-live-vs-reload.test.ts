/**
 * The live stream and the reloaded transcript must render the same turn.
 *
 * Two independent switch statements build message parts from one sequence of
 * neutral events: the hub's `ExternalTurnTranscript`, which produces what is
 * stored, and this app's reducer, which produces what is on screen while the
 * turn runs. A divergence between them is invisible until someone reloads the
 * page and the turn they just watched looks different.
 *
 * So both are driven here from a single event sequence and compared. The hub's
 * transcript is imported directly rather than re-implemented — a second copy of
 * the expected output would drift with neither side noticing.
 */

import { describe, expect, it } from 'bun:test';
import { ExternalTurnTranscript } from '@mangostudio/api/internal/modules/external-agents/domain/external-turn-transcript';
import type { ExternalAgentEvent } from '@mangostudio/shared/external-agents';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import {
  externalAgentEventToStreamChunk,
  externalSessionStartedChunk,
  externalSteerChunk,
  externalTurnCompletedChunk,
} from '@mangostudio/shared/streaming';
import type { MessagePart } from '@mangostudio/shared/types';
import {
  createTextGenerationStreamState,
  reduceTextGenerationStreamChunk,
} from '../../../../src/features/generation/text-generation-stream-reducer';

const REDUCER_OPTIONS = { pendingSubagentName: 'Pending subagent' };

/**
 * A turn that exercises every branch, in an order a real vendor produces:
 * reasoning first, prose split by activity, an approval answered mid-flight,
 * sparse usage reported before completion.
 */
const TURN: readonly ExternalAgentEvent[] = [
  { type: 'reasoning_started' },
  { type: 'reasoning_delta', text: 'I should look at ' },
  { type: 'reasoning_delta', text: 'the build script.' },
  { type: 'text_delta', text: 'Checking the build' },
  {
    type: 'activity_started',
    callId: 'call-1',
    activity: { name: 'shell', kind: 'command', title: 'bun run build', detail: 'in /work/repo' },
  },
  { type: 'activity_updated', callId: 'call-1', update: { detail: 'compiling…' } },
  { type: 'activity_completed', callId: 'call-1', result: { status: 'completed', detail: 'ok' } },
  { type: 'text_delta', text: '. It builds.' },
  {
    type: 'approval_requested',
    request: {
      requestId: 'req-1',
      kind: 'file-change',
      title: 'Write dist/index.js',
      detail: '+120 −0',
      options: [
        { id: 'approve', rawLabel: 'Approve for this session', isDestructive: false },
        { id: 'deny', rawLabel: 'Deny', isDestructive: true },
      ],
      expiresAtMs: 1_800_000_000_000,
    },
  },
  {
    type: 'approval_resolved',
    requestId: 'req-1',
    decision: { optionId: 'approve', source: 'user' },
  },
  {
    type: 'activity_started',
    callId: 'call-2',
    activity: { name: 'apply_patch', kind: 'file-change', title: 'dist/index.js' },
  },
  { type: 'activity_completed', callId: 'call-2', result: { status: 'failed', detail: 'EACCES' } },
  { type: 'usage', usage: { inputTokens: 900 } },
  { type: 'usage', usage: { outputTokens: 120 } },
  { type: 'completed' },
];

/** What the hub stores, built from the neutral events themselves. */
function storedParts(events: readonly ExternalAgentEvent[]): MessagePart[] {
  const transcript = new ExternalTurnTranscript({
    targetId: 'codex',
    sessionId: 'hub-session-1',
    startedAt: 0,
  });
  events.forEach((event, index) => {
    transcript.apply(event, { sequence: index + 1, at: 0 });
  });
  return transcript.parts;
}

/** What the client renders, built from the chunks those events project onto. */
function streamedParts(events: readonly ExternalAgentEvent[]): MessagePart[] {
  const chunks: StreamChunk[] = [
    externalSessionStartedChunk({ sessionId: 'hub-session-1', targetId: 'codex', resumed: false }),
  ];
  for (const event of events) {
    const chunk = externalAgentEventToStreamChunk(event);
    if (chunk) chunks.push(chunk);
    if (event.type === 'completed') chunks.push(externalTurnCompletedChunk('completed'));
  }
  const state = chunks.reduce(
    (current, chunk) => reduceTextGenerationStreamChunk(current, chunk, REDUCER_OPTIONS),
    createTextGenerationStreamState({ userMessageId: 'user-1', aiMessageId: 'ai-1' })
  );
  return state.parts;
}

/**
 * Drops the few fields only the hub can know.
 *
 * `lastSequence`, `eventCount` and `persistedBytes` describe what was written to
 * disk. The timestamps — including an approval's `resolvedAt` — come from the
 * server's clock, and a client stamping its own would put a time in the
 * transcript that disagrees with the record by however far the two clocks are
 * apart. The live view has no honest value for any of them and does not invent
 * one; everything a user actually reads is compared exactly.
 */
function comparable(parts: readonly MessagePart[]): unknown[] {
  return parts.map((part) => {
    if (part.type === 'external_turn') {
      const { lastSequence, eventCount, persistedBytes, startedAt, updatedAt, ...rest } = part;
      return rest;
    }
    if (part.type === 'external_approval') {
      const { resolvedAt, ...rest } = part;
      return rest;
    }
    if (part.type === 'external_steer') {
      const { createdAt, ...rest } = part;
      return rest;
    }
    return part;
  });
}

describe('external turn: live stream vs reloaded transcript', () => {
  it('produces the same parts from the same events', () => {
    expect(comparable(streamedParts(TURN))).toEqual(comparable(storedParts(TURN)));
  });

  it('splits prose where the vendor split it, rather than collapsing it', () => {
    const texts = streamedParts(TURN).filter((part) => part.type === 'text');
    expect(texts).toEqual([
      { type: 'text', text: 'Checking the build' },
      { type: 'text', text: '. It builds.' },
    ]);
    expect(comparable(streamedParts(TURN))).toEqual(comparable(storedParts(TURN)));
  });

  it('keeps the vendor option set in the vendor order on both paths', () => {
    for (const parts of [streamedParts(TURN), storedParts(TURN)]) {
      const approval = parts.find((part) => part.type === 'external_approval');
      expect(approval).toMatchObject({
        options: [
          { id: 'approve', rawLabel: 'Approve for this session', isDestructive: false },
          { id: 'deny', rawLabel: 'Deny', isDestructive: true },
        ],
        decision: 'approve',
        decisionSource: 'user',
      });
    }
  });

  it('merges sparse usage rather than letting a later report erase an earlier field', () => {
    const turn = streamedParts(TURN).find((part) => part.type === 'external_turn');
    expect(turn).toMatchObject({ usage: { inputTokens: 900, outputTokens: 120 } });
  });

  it('agrees on a turn that ends the way only the hub can decide', () => {
    const interrupted = TURN.slice(0, 7);
    const stored = new ExternalTurnTranscript({
      targetId: 'codex',
      sessionId: 'hub-session-1',
      startedAt: 0,
    });
    interrupted.forEach((event, index) => {
      stored.apply(event, { sequence: index + 1, at: 0 });
    });
    stored.finalize('runtime-disconnected', 0);

    const chunks: StreamChunk[] = [
      externalSessionStartedChunk({
        sessionId: 'hub-session-1',
        targetId: 'codex',
        resumed: false,
      }),
      ...interrupted
        .map((event) => externalAgentEventToStreamChunk(event))
        .filter((chunk): chunk is StreamChunk => chunk !== null),
      externalTurnCompletedChunk('runtime-disconnected'),
    ];
    const live = chunks.reduce(
      (current, chunk) => reduceTextGenerationStreamChunk(current, chunk, REDUCER_OPTIONS),
      createTextGenerationStreamState({ userMessageId: 'user-1', aiMessageId: 'ai-1' })
    );

    expect(comparable(live.parts)).toEqual(comparable(stored.parts));
  });

  /**
   * `display: "omitted"` is the API default on current models, so a reasoning
   * phase that opens and receives no `reasoning_delta` at all is the common
   * case, not an edge case. Both `ExternalTurnTranscript#finalize` and the
   * reducer's `external_turn_completed` case drop the same trailing empty
   * `thinking` part, so a live render that pulsed briefly and a reload must
   * agree there is nothing left to show for that phase.
   */
  it('agrees that an empty trailing reasoning phase does not survive the turn', () => {
    const EMPTY_REASONING_TURN: readonly ExternalAgentEvent[] = [
      { type: 'reasoning_started' },
      { type: 'completed' },
    ];
    expect(comparable(streamedParts(EMPTY_REASONING_TURN))).toEqual(
      comparable(storedParts(EMPTY_REASONING_TURN))
    );
    expect(streamedParts(EMPTY_REASONING_TURN).some((part) => part.type === 'thinking')).toBe(
      false
    );
  });

  /**
   * No vendor event describes a sentence stopping mid-thought, so the marker
   * is derived once, at the turn's own terminal reason, in both projections —
   * `ExternalTurnTranscript.finalize` and the reducer's
   * `external_turn_completed` case. A test that only drove one of them could
   * not tell a persisted marker from one that only ever existed live.
   */
  it('agrees that a turn cut short marks its trailing prose as incomplete', () => {
    const cutShort = TURN.slice(0, 4);
    const stored = new ExternalTurnTranscript({
      targetId: 'codex',
      sessionId: 'hub-session-1',
      startedAt: 0,
    });
    cutShort.forEach((event, index) => {
      stored.apply(event, { sequence: index + 1, at: 0 });
    });
    stored.finalize('runtime-disconnected', 0);

    const chunks: StreamChunk[] = [
      externalSessionStartedChunk({
        sessionId: 'hub-session-1',
        targetId: 'codex',
        resumed: false,
      }),
      ...cutShort
        .map((event) => externalAgentEventToStreamChunk(event))
        .filter((chunk): chunk is StreamChunk => chunk !== null),
      externalTurnCompletedChunk('runtime-disconnected'),
    ];
    const live = chunks.reduce(
      (current, chunk) => reduceTextGenerationStreamChunk(current, chunk, REDUCER_OPTIONS),
      createTextGenerationStreamState({ userMessageId: 'user-1', aiMessageId: 'ai-1' })
    );

    expect(comparable(live.parts)).toEqual(comparable(stored.parts));
    const text = live.parts.find((part) => part.type === 'text');
    expect(text).toMatchObject({ incomplete: true });
  });

  /**
   * The vendor closing an empty reasoning phase says it was withheld, not that
   * it is still running — so both projections drop it right there, wherever it
   * sits, rather than waiting to see whether it ends up trailing.
   */
  it('agrees that a closed empty reasoning phase leaves nothing behind', () => {
    const CLOSED_EMPTY_PHASE: readonly ExternalAgentEvent[] = [
      { type: 'reasoning_started' },
      { type: 'reasoning_ended' },
      { type: 'text_delta', text: 'here it is' },
      { type: 'completed' },
    ];
    expect(comparable(streamedParts(CLOSED_EMPTY_PHASE))).toEqual(
      comparable(storedParts(CLOSED_EMPTY_PHASE))
    );
    expect(streamedParts(CLOSED_EMPTY_PHASE).some((part) => part.type === 'thinking')).toBe(false);
  });

  /**
   * The reported defect, in both projections at once: the turn stopped inside
   * the reasoning phase, so the paragraph before it — which the vendor
   * finished and moved on from — must not be labelled cut off, and the empty
   * phase itself has no text to have been cut off either.
   */
  it('agrees that stopping inside an empty reasoning phase marks nothing', () => {
    const stoppedInReasoning: readonly ExternalAgentEvent[] = [
      { type: 'text_delta', text: 'Here is the plan.' },
      { type: 'reasoning_started' },
    ];
    const stored = new ExternalTurnTranscript({
      targetId: 'codex',
      sessionId: 'hub-session-1',
      startedAt: 0,
    });
    stoppedInReasoning.forEach((event, index) => {
      stored.apply(event, { sequence: index + 1, at: 0 });
    });
    stored.finalize('cancelled-by-user', 0);

    const chunks: StreamChunk[] = [
      externalSessionStartedChunk({
        sessionId: 'hub-session-1',
        targetId: 'codex',
        resumed: false,
      }),
      ...stoppedInReasoning
        .map((event) => externalAgentEventToStreamChunk(event))
        .filter((chunk): chunk is StreamChunk => chunk !== null),
      externalTurnCompletedChunk('cancelled-by-user'),
    ];
    const live = chunks.reduce(
      (current, chunk) => reduceTextGenerationStreamChunk(current, chunk, REDUCER_OPTIONS),
      createTextGenerationStreamState({ userMessageId: 'user-1', aiMessageId: 'ai-1' })
    );

    expect(comparable(live.parts)).toEqual(comparable(stored.parts));
    expect(live.parts.some((part) => part.type === 'thinking')).toBe(false);
    expect(live.parts.find((part) => part.type === 'text')).not.toHaveProperty('incomplete');
  });

  it('agrees that a turn which finished normally marks nothing incomplete', () => {
    expect(comparable(streamedParts(TURN))).toEqual(comparable(storedParts(TURN)));
    const text = streamedParts(TURN)
      .filter((part) => part.type === 'text')
      .at(-1);
    expect(text).not.toHaveProperty('incomplete');
  });

  /**
   * Steering is hub-originated rather than projected from a neutral event —
   * see `ExternalTurnTranscript.recordSteerAttempt` and `externalSteerChunk`
   * — so it needs its own parity check rather than a place in `TURN`.
   */
  describe('a mid-turn steer', () => {
    function storedWithSteer(outcome: 'accepted' | 'rejected'): MessagePart[] {
      const transcript = new ExternalTurnTranscript({
        targetId: 'codex',
        sessionId: 'hub-session-1',
        startedAt: 0,
      });
      const prefix = TURN.slice(0, 4);
      prefix.forEach((event, index) => {
        transcript.apply(event, { sequence: index + 1, at: 0 });
      });
      transcript.recordSteerAttempt({ clientMessageId: 'steer-1', text: 'use the helper' }, 0);
      if (outcome === 'rejected') transcript.resolveSteerRejected('steer-1', 'turn-not-steerable');
      return transcript.parts;
    }

    function streamedWithSteer(outcome: 'accepted' | 'rejected'): MessagePart[] {
      const prefix = TURN.slice(0, 4);
      const chunks: StreamChunk[] = [
        externalSessionStartedChunk({
          sessionId: 'hub-session-1',
          targetId: 'codex',
          resumed: false,
        }),
        ...prefix
          .map((event) => externalAgentEventToStreamChunk(event))
          .filter((chunk): chunk is StreamChunk => chunk !== null),
        ...(outcome === 'rejected'
          ? [
              externalSteerChunk({
                clientMessageId: 'steer-1',
                text: 'use the helper',
                status: 'rejected',
                reasonCode: 'turn-not-steerable',
              }),
            ]
          : [
              externalSteerChunk({
                clientMessageId: 'steer-1',
                text: 'use the helper',
                status: 'accepted',
              }),
            ]),
      ];
      const state = chunks.reduce(
        (current, chunk) => reduceTextGenerationStreamChunk(current, chunk, REDUCER_OPTIONS),
        createTextGenerationStreamState({ userMessageId: 'user-1', aiMessageId: 'ai-1' })
      );
      return state.parts;
    }

    it('renders an accepted steer the same on both paths', () => {
      expect(comparable(streamedWithSteer('accepted'))).toEqual(
        comparable(storedWithSteer('accepted'))
      );
      const part = streamedWithSteer('accepted').find((entry) => entry.type === 'external_steer');
      expect(part).toMatchObject({ text: 'use the helper', status: 'accepted' });
    });

    it('renders a rejected steer the same on both paths, reason included', () => {
      expect(comparable(streamedWithSteer('rejected'))).toEqual(
        comparable(storedWithSteer('rejected'))
      );
      const part = streamedWithSteer('rejected').find((entry) => entry.type === 'external_steer');
      expect(part).toMatchObject({
        text: 'use the helper',
        status: 'rejected',
        reasonCode: 'turn-not-steerable',
      });
    });

    it('does not duplicate a redelivered steer chunk', () => {
      const chunk = externalSteerChunk({
        clientMessageId: 'steer-1',
        text: 'use the helper',
        status: 'accepted',
      });
      const state = [chunk, chunk].reduce(
        (current, next) => reduceTextGenerationStreamChunk(current, next, REDUCER_OPTIONS),
        createTextGenerationStreamState({ userMessageId: 'user-1', aiMessageId: 'ai-1' })
      );
      expect(state.parts.filter((part) => part.type === 'external_steer')).toHaveLength(1);
    });
  });
});
