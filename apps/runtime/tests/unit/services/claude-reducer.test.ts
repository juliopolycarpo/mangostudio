/**
 * The Claude `stream-json` reducer, driven by transcripts a live CLI produced.
 *
 * The two fixtures are **recordings, not fabrications**. Both came from
 * `claude 2.1.226` on a signed-in account, with paths and identifiers scrubbed
 * and nothing else changed. That matters more here than in most reducer tests:
 * the record vocabulary is undocumented and wider than any written plan
 * enumerated, so a hand-written fixture would only ever prove that the reducer
 * agrees with whoever wrote the fixture.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExternalAgentEvent } from '@mangostudio/shared/external-agents';
import { parseClaudeStreamLine } from '../../../src/services/external-agents/claude/protocol';
import {
  ClaudeTurnReducer,
  claudeActivityKind,
  type readClaudeInit,
} from '../../../src/services/external-agents/claude/reducer';

const FIXTURES = join(import.meta.dir, '../../support/fixtures');

function records(name: string) {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .trim()
    .split('\n')
    .map((line) => parseClaudeStreamLine(line))
    .filter((record) => record !== undefined);
}

function reduceAll(
  name: string,
  options: { readonly resumed?: boolean } = {}
): { events: ExternalAgentEvent[]; inits: ReturnType<typeof readClaudeInit>[] } {
  const inits: ReturnType<typeof readClaudeInit>[] = [];
  const reducer = new ClaudeTurnReducer({
    resumed: options.resumed ?? false,
    onInit: (init) => inits.push(init),
  });
  const events: ExternalAgentEvent[] = [];
  for (const record of records(name)) {
    for (const event of reducer.reduce(record).events) events.push(event);
  }
  return { events, inits };
}

describe('ClaudeTurnReducer, on a recorded read-a-file turn', () => {
  it('opens the session from the init record', () => {
    const { events, inits } = reduceAll('claude-read-turn.jsonl');
    expect(events[0]).toEqual({
      type: 'session_started',
      sessionId: 'b01414e7-4b4b-43a2-9109-a33e21664340',
      resumed: false,
    });
    expect(inits[0]?.capabilities).toContain('msg_lifecycle_v1');
    expect(inits[0]?.permissionMode).toBe('plan');
  });

  /**
   * The recording is a `2.1.226` run: it lists 71 names under `slash_commands`
   * — `gh` and `dataviz` among them, but `doctor`, `color`, `clear` and
   * `heapdump` too — and carries no `terminal_slash_commands`. That build is
   * inside the supported range, so this is the shape a real user hits, and the
   * only honest answer to it is no catalog at all. `the init record’s
   * slash-command list` covers the runs that do state their exclusions.
   */
  it('announces no catalog for a run that predates the terminal-only list', () => {
    const { events } = reduceAll('claude-read-turn.jsonl');
    expect(events.find((event) => event.type === 'commands_available')).toBeUndefined();
  });

  it('reports the resume state it was opened with rather than inferring one', () => {
    const { events } = reduceAll('claude-read-turn.jsonl', { resumed: true });
    expect(events[0]).toMatchObject({ type: 'session_started', resumed: true });
  });

  /**
   * The duplication guard. `--include-partial-messages` puts every assistant
   * block on the wire twice — once as deltas, once as a completed message — so a
   * reducer that read both would double the whole reply.
   */
  it('delivers assistant text once, from the deltas only', () => {
    const { events } = reduceAll('claude-read-turn.jsonl');
    const text = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.text)
      .join('');
    expect(text).toBe('mango');
  });

  /**
   * The recorded run carries `thinking_delta` frames whose `thinking` field is
   * an empty string — this account reports thinking *token counts* without
   * exposing the text. Emitting an empty `reasoning_delta` for each would open a
   * reasoning block in the transcript that never receives a character, so the
   * honest reduction is nothing at all.
   */
  it('emits no reasoning when the vendor withholds the thinking text', () => {
    const { events } = reduceAll('claude-read-turn.jsonl');
    expect(events.some((event) => event.type === 'reasoning_delta')).toBe(false);
  });

  it('streams thinking as reasoning, not as text, when the vendor sends it', () => {
    const subject = new ClaudeTurnReducer({ resumed: false });
    const events = subject.reduce({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'weighing the options' },
      },
    }).events;
    expect(events).toEqual([{ type: 'reasoning_delta', text: 'weighing the options' }]);
  });

  it("labels the activity with Claude's own tool name, verbatim", () => {
    const { events } = reduceAll('claude-read-turn.jsonl');
    const started = events.find((event) => event.type === 'activity_started');
    expect(started).toMatchObject({
      type: 'activity_started',
      callId: 'toolu_01LZJqPzShDSj9cPgL7PeD1v',
      activity: { name: 'Read', kind: 'other', title: '/work/repo/note.txt' },
    });
  });

  it('closes the activity when its tool result arrives', () => {
    const { events } = reduceAll('claude-read-turn.jsonl');
    const completed = events.find((event) => event.type === 'activity_completed');
    expect(completed).toMatchObject({
      type: 'activity_completed',
      callId: 'toolu_01LZJqPzShDSj9cPgL7PeD1v',
      result: { status: 'completed' },
    });
  });

  it('ends with usage and a completion', () => {
    const { events } = reduceAll('claude-read-turn.jsonl');
    expect(events.at(-1)).toEqual({ type: 'completed' });
    expect(events.at(-2)).toMatchObject({
      type: 'usage',
      usage: { inputTokens: 4, outputTokens: 775, cacheReadTokens: 30_122 },
    });
  });

  it('emits no approval, because Claude never offers one to answer', () => {
    const { events } = reduceAll('claude-read-turn.jsonl');
    expect(events.some((event) => event.type === 'approval_requested')).toBe(false);
  });
});

describe('ClaudeTurnReducer, on a recorded denied write', () => {
  /**
   * The whole basis for `interactiveApprovals: false`. Claude does not ask; it
   * refuses, reports the refusal and exits successfully.
   */
  it('reports the denial as a failed activity, not as a pending approval', () => {
    const { events } = reduceAll('claude-denied-write-turn.jsonl');
    expect(events.some((event) => event.type === 'approval_requested')).toBe(false);
    expect(events.find((event) => event.type === 'activity_completed')).toMatchObject({
      result: { status: 'failed' },
    });
  });

  it('completes the turn rather than failing it', () => {
    const { events } = reduceAll('claude-denied-write-turn.jsonl');
    expect(events.at(-1)).toEqual({ type: 'completed' });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  /**
   * The result record's `permission_denials` is deliberately not turned into an
   * event of its own: the denied call already closed as a failed activity, and a
   * second rendering of the same refusal would read as two things going wrong.
   */
  it('reports the denial once, through the activity that was refused', () => {
    const { events } = reduceAll('claude-denied-write-turn.jsonl');
    expect(events.filter((event) => event.type === 'activity_completed')).toHaveLength(1);
  });

  /**
   * This recording has zero `stream_event` records — the fixture that exposed
   * `#reduceAssistant` skipping main-conversation text unconditionally, on the
   * assumption a delta stream had already delivered it. Nothing did, so the
   * refusal was the vendor's entire visible reply and reached nothing.
   */
  it('delivers the assistant text even though the run carried no partial messages', () => {
    const { events } = reduceAll('claude-denied-write-turn.jsonl');
    const text = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.text)
      .join('');
    expect(text).toBe(
      'I need permission to write the file. Please approve the request to write to `denied.txt` so I can create the file with the content "hello".'
    );
  });

  /**
   * Same defect, same fix: a `thinking` block with real text is exactly as
   * dependent on delta delivery as a `text` block is, and this run delivered
   * neither. Two separate messages each reason once, in the order they ran.
   */
  it('delivers the assistant reasoning even though the run carried no partial messages', () => {
    const { events } = reduceAll('claude-denied-write-turn.jsonl');
    const reasoning = events
      .filter((event) => event.type === 'reasoning_delta')
      .map((event) => event.text);
    expect(reasoning).toEqual([
      'The user is asking me to create a file named denied.txt containing the word "hello" using the Write tool. This is a straightforward task.\n\nI need to use the Write tool with:\n- file_path: The absolute path to the file. The working directory is /work/repo, so the file should be at /work/repo/denied.txt\n- content: "hello"\n\nLet me create this file.',
      "The user hasn't granted permission to write to that file yet. I need to wait for them to approve this action. Let me inform them that permission is needed.",
    ]);
  });
});

describe('ClaudeTurnReducer, on records it has never seen', () => {
  const reducer = () => new ClaudeTurnReducer({ resumed: false });

  it('ignores an unknown top-level record type', () => {
    expect(reducer().reduce({ type: 'quantum_event', payload: 1 }).events).toEqual([]);
  });

  it('ignores a system subtype with no neutral event behind it', () => {
    const subject = reducer();
    expect(subject.reduce({ type: 'system', subtype: 'api_retry', attempt: 2 }).events).toEqual([]);
    expect(
      subject.reduce({ type: 'system', subtype: 'status', status: 'requesting' }).events
    ).toEqual([]);
    expect(subject.reduce({ type: 'rate_limit_event', rate_limit_info: {} }).events).toEqual([]);
  });

  it('ignores a malformed content block instead of throwing', () => {
    const subject = reducer();
    expect(
      subject.reduce({ type: 'assistant', message: { role: 'assistant', content: 'not-an-array' } })
        .events
    ).toEqual([]);
  });
});

describe('ClaudeTurnReducer subagent handling', () => {
  const SUBAGENT_TURN = [
    { type: 'system', subtype: 'init', session_id: 's1', capabilities: [] },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_task', name: 'Task', input: { prompt: 'explore' } },
        ],
      },
    },
    {
      type: 'assistant',
      parent_tool_use_id: 'toolu_task',
      message: { role: 'assistant', content: [{ type: 'text', text: 'found three files' }] },
    },
    {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'done' }],
      },
    },
    { type: 'result', subtype: 'success', is_error: false, permission_denials: [] },
  ];

  function reduceSubagentTurn(): ExternalAgentEvent[] {
    const subject = new ClaudeTurnReducer({ resumed: false });
    return SUBAGENT_TURN.flatMap((record) => subject.reduce(record).events);
  }

  it("nests a subagent's text under the Task activity that spawned it", () => {
    const events = reduceSubagentTurn();
    expect(events).toContainEqual({
      type: 'activity_updated',
      callId: 'toolu_task',
      update: { detail: 'found three files' },
    });
  });

  /**
   * The ownership line. `subagent_*` events and `SubagentTracePart` describe
   * MangoStudio's own delegation; routing Claude's subagents through them would
   * tell the user MangoStudio made a hand-off it never made.
   */
  it("never promotes a subagent's text into the main transcript", () => {
    const events = reduceSubagentTurn();
    expect(events.some((event) => event.type === 'text_delta')).toBe(false);
  });

  it('gives Task the subagent icon while keeping its vendor name', () => {
    const events = reduceSubagentTurn();
    expect(events.find((event) => event.type === 'activity_started')).toMatchObject({
      activity: { name: 'Task', kind: 'subagent' },
    });
  });
});

describe('ClaudeTurnReducer termination', () => {
  it('cancels activities still open when the result arrives', () => {
    const subject = new ClaudeTurnReducer({ resumed: false });
    subject.reduce({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_open', name: 'Bash', input: { command: 'sleep' } },
        ],
      },
    });
    const events = subject.reduce({ type: 'result', subtype: 'success', is_error: false }).events;
    expect(events[0]).toEqual({
      type: 'activity_completed',
      callId: 'toolu_open',
      result: { status: 'cancelled' },
    });
  });

  it('reports a failed result as a structured error', () => {
    const subject = new ClaudeTurnReducer({ resumed: false });
    const events = subject.reduce({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'No conversation found with session ID: abc',
      api_error_status: 404,
    }).events;
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: {
        code: 'claude-error_during_execution',
        message: 'No conversation found with session ID: abc',
        vendorCode: '404',
      },
    });
  });

  it('stops reducing after the result', () => {
    const subject = new ClaudeTurnReducer({ resumed: false });
    subject.reduce({ type: 'result', subtype: 'success', is_error: false });
    expect(subject.finished).toBe(true);
    expect(
      subject.reduce({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'late' } },
      }).events
    ).toEqual([]);
  });

  it('closes a run whose process died without a result', () => {
    const subject = new ClaudeTurnReducer({ resumed: false });
    subject.reduce({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_open', name: 'Bash', input: {} }],
      },
    });
    const events = subject.abort({ code: 'claude-no-result', message: 'died' });
    expect(events).toEqual([
      { type: 'activity_completed', callId: 'toolu_open', result: { status: 'cancelled' } },
      { type: 'error', error: { code: 'claude-no-result', message: 'died' } },
    ]);
  });
});

describe('claudeActivityKind', () => {
  it.each([
    ['Bash', 'command'],
    ['Edit', 'file-change'],
    ['Write', 'file-change'],
    ['Task', 'subagent'],
    ['WebSearch', 'web-search'],
    ['TodoWrite', 'plan'],
    ['mcp__playwright__navigate', 'mcp'],
  ] as const)('maps %s onto %s', (name, kind) => {
    expect(claudeActivityKind(name)).toBe(kind);
  });

  /**
   * The default has to be `other`, not a guess. An unrecognized name is far
   * likelier to be a plugin's or an MCP server's than a new built-in, and a
   * shell icon on something that never touched a shell is a false claim.
   */
  it('falls back to other for a tool it does not recognize', () => {
    expect(claudeActivityKind('SomeFuturePluginTool')).toBe('other');
  });
});

describe('the init record’s slash-command list', () => {
  function catalogFrom(record: Record<string, unknown>): readonly { name: string }[] {
    const reducer = new ClaudeTurnReducer({ resumed: false });
    const events = reducer.reduce({ type: 'system', subtype: 'init', ...record }).events;
    const catalog = events.find((event) => event.type === 'commands_available');
    return catalog?.type === 'commands_available' ? catalog.commands : [];
  }

  /**
   * The vendor's own statement that a name needs the interactive terminal this
   * adapter never gives it. Offering one would insert a command that silently
   * does nothing.
   */
  it('withholds the names the run marked terminal-only', () => {
    const commands = catalogFrom({
      session_id: 'a',
      slash_commands: ['review', 'doctor', 'color'],
      terminal_slash_commands: ['doctor', 'color'],
    });
    expect(commands.map((command) => command.name)).toEqual(['review']);
  });

  /**
   * The exclusion list is what makes the catalog safe to offer. A run that
   * states it in a shape this cannot read has not been withheld from, so the
   * honest answer is no catalog — not one that quietly includes `/doctor`.
   */
  it('says nothing when the terminal-only list is unreadable', () => {
    expect(
      catalogFrom({
        session_id: 'a',
        slash_commands: ['review', 'doctor'],
        terminal_slash_commands: 'doctor',
      })
    ).toEqual([]);
  });

  /**
   * The same rule, for the case that actually ships: `terminal_slash_commands`
   * is newer than the oldest build this adapter supports, and the ones without
   * it still announce `doctor` and `color` under `slash_commands`. An absent
   * list is a run that has told us nothing, not a run that excluded nothing.
   */
  it('says nothing when the run predates the terminal-only list', () => {
    expect(catalogFrom({ session_id: 'a', slash_commands: ['review', 'doctor', 'color'] })).toEqual(
      []
    );
  });

  it('withholds the CLI’s private plumbing', () => {
    const commands = catalogFrom({
      session_id: 'a',
      slash_commands: ['__remote-workflow', 'compact'],
      terminal_slash_commands: [],
    });
    expect(commands.map((command) => command.name)).toEqual(['compact']);
  });

  /**
   * A run that failed to name itself still knows what it can expand, and the
   * palette is useful without a session handle it does not need.
   */
  it('announces the catalog even when the run carried no session id', () => {
    expect(catalogFrom({ slash_commands: ['review'], terminal_slash_commands: [] })).toEqual([
      { name: 'review' },
    ]);
  });

  it('says nothing when the run announced no list at all', () => {
    expect(catalogFrom({ session_id: 'a' })).toEqual([]);
  });
});
