/**
 * The reducer, replayed against the recorded transcript.
 *
 * Every payload here came off a live `cursor-agent acp`, so a shape the author
 * misremembered cannot pass. What the assertions care about is the neutral
 * sequence: which events, in which order, correlated how.
 */

import { describe, expect, it } from 'bun:test';
import type { ExternalAgentEvent } from '@mangostudio/shared/external-agents';
import { CursorTurnReducer } from '../../../src/services/external-agents/cursor/reducer';
import { CURSOR_TRANSCRIPT } from '../../support/cursor-fixtures';

function replay(
  updates: readonly unknown[],
  now: () => number = () => 0
): readonly ExternalAgentEvent[] {
  const reducer = new CursorTurnReducer(now);
  return updates.flatMap((update) => reducer.reduce(update).events);
}

describe('cursor reducer — a recorded turn', () => {
  it('produces text, reasoning and one bracketed tool call, in order', () => {
    const events = replay(CURSOR_TRANSCRIPT.updates);
    const types = events.map((event) => event.type);

    expect(types).toEqual([
      // The recording opens with the catalog, which is where the live stream
      // puts it: Cursor announces what the session can expand before it says
      // anything else, and never again.
      'commands_available',
      'reasoning_delta',
      'reasoning_delta',
      'text_delta',
      'text_delta',
      'activity_started',
      'activity_completed',
      'reasoning_delta',
      'text_delta',
    ]);
  });

  it('renders the vendor kind as the activity name and its prose as the title', () => {
    const started = replay(CURSOR_TRANSCRIPT.updates).find(
      (event) => event.type === 'activity_started'
    );

    expect(started).toMatchObject({
      type: 'activity_started',
      activity: { name: 'execute', kind: 'command', title: '`echo hello-from-acp`' },
    });
  });

  it('never puts the vendor call id on the wire', () => {
    // The live build's `toolCallId` carries an embedded newline and 85 code
    // points before any growth; the neutral contract throws past 128. A handle
    // is minted instead, and both ends of the bracket use the same one.
    const events = replay(CURSOR_TRANSCRIPT.updates);
    const started = events.find((event) => event.type === 'activity_started');
    const completed = events.find((event) => event.type === 'activity_completed');
    const callId = started?.type === 'activity_started' ? started.callId : '';

    expect(callId).not.toContain('\n');
    expect(callId).not.toContain('fc_');
    expect(callId.length).toBeLessThanOrEqual(32);
    expect(completed).toMatchObject({ type: 'activity_completed', callId });
  });

  it('carries the vendor output onto the completion', () => {
    const completed = replay(CURSOR_TRANSCRIPT.updates).find(
      (event) => event.type === 'activity_completed'
    );

    expect(completed).toMatchObject({
      type: 'activity_completed',
      result: { status: 'completed' },
    });
    const detail = completed?.type === 'activity_completed' ? (completed.result.detail ?? '') : '';
    expect(detail).toContain('hello-from-acp');
  });

  it('reports truncation by what was cut, not by how wide the result reads', () => {
    // A cut counts code points; `String.length` counts UTF-16 units. Measuring
    // the result would call 1,100 astral characters truncated although nothing
    // was dropped, and would miss a cut that landed exactly on the bound.
    const wide = '\u{1F600}'.repeat(1_100);
    const long = 'a'.repeat(5_000);
    const call = (text: string) => ({
      sessionUpdate: 'tool_call',
      toolCallId: `call-${text.length}`,
      kind: 'execute',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text } }],
    });

    const [intact] = replay([call(wide)]);
    expect(intact).toMatchObject({ type: 'activity_started' });
    expect(intact?.type === 'activity_started' ? intact.activity.truncated : 'missing').toBe(
      undefined
    );

    const [cut] = replay([call(long)]);
    expect(cut?.type === 'activity_started' ? cut.activity.truncated : undefined).toBe(true);
  });

  it('ignores additive variants and the ones that are not the turn talking', () => {
    const events = replay([
      { sessionUpdate: 'quantum_update', payload: { anything: true } },
      { sessionUpdate: 'session_info_update', title: 'Cursor picked its own title' },
      { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'the prompt' } },
      undefined,
      'not an object',
    ]);

    expect(events).toEqual([]);
  });
});

describe('cursor reducer — how a turn ends', () => {
  it('reports `end_turn` as completion', () => {
    const reducer = new CursorTurnReducer(() => 0);
    expect(reducer.finish('end_turn')).toEqual([{ type: 'completed' }]);
  });

  it('says nothing extra when the ending is a cancel it asked for', () => {
    const reducer = new CursorTurnReducer(() => 0);
    expect(reducer.finish('cancelled')).toEqual([]);
  });

  it('reports a vendor-side stop as an error carrying its reason', () => {
    const reducer = new CursorTurnReducer(() => 0);
    const [event] = reducer.finish('max_tokens');

    expect(event).toMatchObject({
      type: 'error',
      error: { code: 'vendor-turn-incomplete', vendorCode: 'max_tokens', retryable: false },
    });
  });

  it('finishes only once', () => {
    const reducer = new CursorTurnReducer(() => 0);
    reducer.finish('end_turn');
    expect(reducer.finish('end_turn')).toEqual([]);
  });

  it('closes a tool call the vendor never terminated', () => {
    // Otherwise the pill renders as still running for as long as the transcript
    // exists, which is a claim about the vendor's work that nothing supports.
    const reducer = new CursorTurnReducer(() => 0);
    reducer.reduce({
      sessionUpdate: 'tool_call',
      toolCallId: 'abandoned',
      kind: 'execute',
      title: 'sleep 900',
      status: 'in_progress',
    });

    const [closing] = reducer.finish('end_turn');
    expect(closing).toMatchObject({
      type: 'activity_completed',
      result: { status: 'completed' },
    });
  });

  it('closes a dangling call as failed when the turn itself failed', () => {
    const reducer = new CursorTurnReducer(() => 0);
    reducer.reduce({
      sessionUpdate: 'tool_call',
      toolCallId: 'abandoned',
      kind: 'execute',
      title: 'sleep 900',
    });

    expect(reducer.finish('refusal')[0]).toMatchObject({
      type: 'activity_completed',
      result: { status: 'failed' },
    });
  });
});

describe('cursor reducer — progress', () => {
  it('coalesces in-flight output to one update per window', () => {
    let clock = 0;
    const reducer = new CursorTurnReducer(() => clock);
    reducer.reduce({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'execute', title: 'ls' });

    const first = reducer.reduce({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'one' } }],
    });
    const immediate = reducer.reduce({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'two' } }],
    });
    clock += 6_000;
    const later = reducer.reduce({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'three' } }],
    });

    expect(first.events).toHaveLength(1);
    expect(immediate.events).toEqual([]);
    expect(later.events).toHaveLength(1);
  });

  it('opens a bracket for a call first seen through the update channel', () => {
    const reducer = new CursorTurnReducer(() => 0);
    const reduction = reducer.reduce({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'never-opened',
      kind: 'edit',
      title: 'src/index.ts',
      status: 'in_progress',
    });

    expect(reduction.events[0]).toMatchObject({
      type: 'activity_started',
      activity: { kind: 'file-change', name: 'edit' },
    });
  });

  it('renders the plan as one activity that is updated rather than repeated', () => {
    const reducer = new CursorTurnReducer(() => 0);
    const first = reducer.reduce({
      sessionUpdate: 'plan',
      entries: [{ content: 'Read the file', status: 'pending' }],
    });
    const second = reducer.reduce({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the file', status: 'completed' },
        { content: 'Write the fix', status: 'pending' },
      ],
    });

    expect(first.events[0]).toMatchObject({
      type: 'activity_started',
      activity: { kind: 'plan', name: 'plan', title: '1 step' },
    });
    expect(second.events[0]).toMatchObject({
      type: 'activity_updated',
      update: { title: '2 steps' },
    });
    expect(first.events[0]?.type === 'activity_started' ? first.events[0].callId : '').toBe(
      second.events[0]?.type === 'activity_updated' ? second.events[0].callId : 'x'
    );
  });
});

describe('cursor reducer — the slash-command catalog', () => {
  it('projects the announced commands, descriptions and all', () => {
    const [event] = replay([
      {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'test-command', description: 'Accessibility Audit (user)' },
          { name: 'autopilot', description: 'Keep a PR merge-ready. (builtin skill)' },
        ],
      },
    ]);

    expect(event).toEqual({
      type: 'commands_available',
      commands: [
        { name: 'test-command', description: 'Accessibility Audit (user)' },
        { name: 'autopilot', description: 'Keep a PR merge-ready. (builtin skill)' },
      ],
    });
  });

  it('drops rows with no usable name and omits an empty description', () => {
    const [event] = replay([
      {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: '   ', description: 'nameless' },
          { description: 'also nameless' },
          'not an object',
          { name: 'review', description: '  ' },
        ],
      },
    ]);

    expect(event).toEqual({ type: 'commands_available', commands: [{ name: 'review' }] });
  });

  it('emits an empty catalog rather than swallowing it', () => {
    // "This session has no commands" is an answer the composer acts on. Staying
    // silent would leave a palette offering whatever the previous session had.
    expect(replay([{ sessionUpdate: 'available_commands_update', availableCommands: [] }])).toEqual(
      [{ type: 'commands_available', commands: [] }]
    );
  });

  it('ignores an update whose command list is not a list', () => {
    expect(
      replay([{ sessionUpdate: 'available_commands_update', availableCommands: 'nope' }])
    ).toEqual([]);
  });
});
