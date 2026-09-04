import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExternalAgentEvent } from '@mangostudio/shared/external-agents';
import { CodexTurnReducer } from '../../../src/services/external-agents/codex/reducer';
import { normalizeExternalAgentEvent } from '../../../src/services/external-agents/normalization';
import {
  agentMessageDelta,
  agentMessageItem,
  commandExecutionItem,
  commandOutputDelta,
  errorNotification,
  fileChangeItem,
  fileChangeItemWithChanges,
  fileChangePatchUpdated,
  fileUpdateChange,
  itemCompleted,
  itemStarted,
  mcpToolCallProgress,
  reasoningItem,
  reasoningSummaryDelta,
  TURN_ID,
  tokenUsageUpdated,
  turnCompleted,
  userMessageItem,
} from '../../support/codex-fixtures';

/** Replay a notification sequence and return the neutral events it produced. */
function replay(
  notifications: ReadonlyArray<readonly [string, unknown]>,
  turnId = TURN_ID
): ExternalAgentEvent[] {
  const reducer = new CodexTurnReducer(turnId);
  return notifications.flatMap(([method, params]) => [...reducer.reduce(method, params).events]);
}

/** A clock the test advances by hand, so coalescing is asserted, not timed. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('codex reducer — the captured real turn', () => {
  /**
   * A transcript captured from a live `codex app-server` 0.147.0 on
   * 2026-08-08, notifications only. Real captures pin **ordering**: this is the
   * evidence that `thread/tokenUsage/updated` really does arrive before
   * `turn/completed`, that deltas really are keyed by `itemId`, and that the
   * user message really is echoed back. Nothing in it was written by hand.
   */
  const transcript = readFileSync(
    join(import.meta.dir, '../../fixtures/codex/real-text-turn.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { method: string; params: unknown });

  it('reduces it to exactly the neutral sequence, dropping the echo', () => {
    const realTurnId = '019fe6d2-e0fc-73f2-a1ee-3a190d09293b';
    const reducer = new CodexTurnReducer(realTurnId);
    const events = transcript.flatMap((frame) => [
      ...reducer.reduce(frame.method, frame.params).events,
    ]);

    expect(events).toEqual([
      { type: 'text_delta', text: 'M' },
      { type: 'text_delta', text: 'ANGO' },
      { type: 'text_delta', text: '_OK' },
      {
        type: 'usage',
        usage: {
          inputTokens: 21_424,
          outputTokens: 7,
          cacheReadTokens: 6_912,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 21_431,
        },
      },
      {
        type: 'thread_usage',
        usage: {
          last: {
            inputTokens: 21_424,
            outputTokens: 7,
            cacheReadTokens: 6_912,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 21_431,
          },
          total: {
            inputTokens: 21_424,
            outputTokens: 7,
            cacheReadTokens: 6_912,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 21_431,
          },
          contextWindowTokens: 258_400,
        },
      },
      { type: 'completed' },
    ]);
    expect(reducer.finished).toBe(true);
  });

  it('captures usage before the turn ends, and keeps it through completion', () => {
    const usageIndex = transcript.findIndex(
      (frame) => frame.method === 'thread/tokenUsage/updated'
    );
    const completedIndex = transcript.findIndex((frame) => frame.method === 'turn/completed');
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeLessThan(completedIndex);

    const realTurnId = '019fe6d2-e0fc-73f2-a1ee-3a190d09293b';
    const reducer = new CodexTurnReducer(realTurnId);
    const events = transcript.flatMap((frame) => [
      ...reducer.reduce(frame.method, frame.params).events,
    ]);
    const usageEvent = events.find((event) => event.type === 'usage');
    const completedEvent = events.find((event) => event.type === 'completed');
    expect(usageEvent).toBeDefined();
    expect(completedEvent).toBeDefined();
    if (!usageEvent || !completedEvent) return;
    expect(events.indexOf(usageEvent)).toBeLessThan(events.indexOf(completedEvent));
  });
});

describe('codex reducer — item correlation', () => {
  it('adopts a continuation turn id after steering', () => {
    const reducer = new CodexTurnReducer(TURN_ID);
    reducer.adoptTurnId('continued-turn-id');
    expect(
      reducer.reduce('turn/completed', {
        ...turnCompleted(),
        turn: { ...turnCompleted().turn, id: 'continued-turn-id' },
      }).events
    ).toEqual([{ type: 'completed' }]);
  });

  it('correlates deltas by itemId while two items are open at once', () => {
    const events = replay([
      ['item/started', itemStarted(reasoningItem('think', []))],
      ['item/started', itemStarted(agentMessageItem('say', ''))],
      ['item/reasoning/summaryTextDelta', reasoningSummaryDelta('think', 'weighing')],
      ['item/agentMessage/delta', agentMessageDelta('say', 'hello')],
      ['item/completed', itemCompleted(reasoningItem('think', ['weighing']))],
      ['item/completed', itemCompleted(agentMessageItem('say', 'hello'))],
      ['turn/completed', turnCompleted()],
    ]);

    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'weighing' },
      { type: 'text_delta', text: 'hello' },
      { type: 'completed' },
    ]);
  });

  it('emits only the remainder when a completion carries more than the deltas did', () => {
    const events = replay([
      ['item/started', itemStarted(agentMessageItem('say', ''))],
      ['item/agentMessage/delta', agentMessageDelta('say', 'par')],
      ['item/completed', itemCompleted(agentMessageItem('say', 'partial'))],
    ]);

    expect(events).toEqual([
      { type: 'text_delta', text: 'par' },
      { type: 'text_delta', text: 'tial' },
    ]);
  });

  it('ignores notifications belonging to another turn', () => {
    const events = replay([
      ['item/agentMessage/delta', agentMessageDelta('say', 'other', 'a-different-turn')],
      ['turn/completed', turnCompleted()],
    ]);
    expect(events).toEqual([{ type: 'completed' }]);
  });
});

describe('codex reducer — item classification', () => {
  it('brackets a command execution as activity, not as text', () => {
    const events = replay([
      ['item/started', itemStarted(commandExecutionItem('cmd', 'bun test', 'inProgress'))],
      ['item/completed', itemCompleted(commandExecutionItem('cmd', 'bun test'))],
    ]);

    expect(events).toEqual([
      {
        type: 'activity_started',
        callId: 'cmd',
        activity: { name: 'commandExecution', kind: 'command', title: 'bun test' },
      },
      { type: 'activity_completed', callId: 'cmd', result: { status: 'completed' } },
    ]);
  });

  it('reports a declined item as cancelled rather than completed', () => {
    const events = replay([
      ['item/completed', itemCompleted(fileChangeItem('patch', ['a.ts'], 'declined'))],
    ]);
    expect(events[0]).toMatchObject({ result: { status: 'cancelled' } });
  });

  it('renders a file change from its tagged kind rather than coercing the object', () => {
    const changes = [
      fileUpdateChange('/workspace/added.ts', { type: 'add' }),
      fileUpdateChange('/workspace/gone.ts', { type: 'delete' }),
      fileUpdateChange('/workspace/edited.ts'),
      fileUpdateChange('/workspace/old.ts', { type: 'update', move_path: '/workspace/new.ts' }),
    ];
    const events = replay([
      ['item/completed', itemCompleted(fileChangeItemWithChanges('patch', changes))],
    ]);

    const detail = events[0]?.type === 'activity_completed' ? events[0].result.detail : undefined;
    expect(detail).toBe(
      [
        'add /workspace/added.ts',
        'delete /workspace/gone.ts',
        'update /workspace/edited.ts',
        'rename /workspace/old.ts → /workspace/new.ts',
      ].join('\n')
    );
    expect(detail).not.toContain('[object Object]');
  });

  it('drops the user message echo so the transcript is not duplicated', () => {
    const events = replay([
      ['item/started', itemStarted(userMessageItem('echo', 'hello'))],
      ['item/completed', itemCompleted(userMessageItem('echo', 'hello'))],
    ]);
    expect(events).toEqual([]);
  });
});

describe('codex reducer — liveness while an activity runs', () => {
  /**
   * The supervisor cancels a turn that emits no neutral event for its idle
   * timeout. A command that streams output for minutes must therefore keep
   * producing events — but coalesced, because the turn's whole payload budget
   * is 2 MB and a build log would spend it.
   */
  function runningCommand(clock: ReturnType<typeof fakeClock>) {
    const reducer = new CodexTurnReducer(TURN_ID, clock.now);
    reducer.reduce(
      'item/started',
      itemStarted(commandExecutionItem('cmd', 'bun test', 'inProgress'))
    );
    return reducer;
  }

  it('keeps a long command alive without forwarding every delta', () => {
    const clock = fakeClock();
    const reducer = runningCommand(clock);

    const updates: ExternalAgentEvent[] = [];
    // Two minutes of output, a chunk every second: twice the idle timeout.
    for (let second = 0; second < 120; second += 1) {
      updates.push(
        ...reducer.reduce(
          'item/commandExecution/outputDelta',
          commandOutputDelta('cmd', `line ${second}\n`)
        ).events
      );
      clock.advance(1_000);
    }

    // Far fewer events than deltas, but never a 60-second silence.
    expect(updates.length).toBeGreaterThan(1);
    expect(updates.length).toBeLessThan(60);
    expect(updates.every((event) => event.type === 'activity_updated')).toBe(true);
    expect(
      updates.every((event) => event.type === 'activity_updated' && event.callId === 'cmd')
    ).toBe(true);
  });

  it('bounds the detail it carries and says when it dropped output', () => {
    const clock = fakeClock();
    const reducer = runningCommand(clock);

    reducer.reduce(
      'item/commandExecution/outputDelta',
      commandOutputDelta('cmd', 'x'.repeat(50_000))
    );
    clock.advance(10_000);
    const [event] = reducer.reduce(
      'item/commandExecution/outputDelta',
      commandOutputDelta('cmd', 'tail')
    ).events;

    expect(event).toMatchObject({ type: 'activity_updated', update: { truncated: true } });
    const detail = event?.type === 'activity_updated' ? (event.update.detail ?? '') : '';
    expect(detail.length).toBeLessThanOrEqual(2_000);
    expect(detail.endsWith('tail')).toBe(true);
  });

  it('follows a trickle delta for delta rather than batching it', () => {
    const clock = fakeClock();
    const reducer = runningCommand(clock);

    const first = reducer.reduce(
      'item/commandExecution/outputDelta',
      commandOutputDelta('cmd', 'a')
    ).events;
    clock.advance(30_000);
    const second = reducer.reduce(
      'item/commandExecution/outputDelta',
      commandOutputDelta('cmd', 'b')
    ).events;

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('reports MCP progress and patch updates on the same channel', () => {
    const clock = fakeClock();
    const reducer = new CodexTurnReducer(TURN_ID, clock.now);
    reducer.reduce('item/started', itemStarted(fileChangeItem('patch', ['a.ts'], 'inProgress')));
    const patch = reducer.reduce(
      'item/fileChange/patchUpdated',
      fileChangePatchUpdated('patch', [fileUpdateChange('/workspace/a.ts', { type: 'add' })])
    ).events;

    expect(patch).toMatchObject([
      { type: 'activity_updated', callId: 'patch', update: { detail: 'add /workspace/a.ts\n' } },
    ]);

    // An item this reducer never bracketed has no call id to attach to.
    expect(
      reducer.reduce('item/mcpToolCall/progress', mcpToolCallProgress('never-seen', 'working'))
        .events
    ).toEqual([]);
  });

  it('ignores output belonging to another turn', () => {
    const clock = fakeClock();
    const reducer = runningCommand(clock);
    expect(
      reducer.reduce(
        'item/commandExecution/outputDelta',
        commandOutputDelta('cmd', 'x', 'other-turn')
      ).events
    ).toEqual([]);
  });
});

describe('codex reducer — failures', () => {
  it('stays quiet while the vendor says it will retry', () => {
    expect(replay([['error', errorNotification('transient', true)]])).toEqual([]);
  });

  it('preserves the vendor error code rather than flattening it to a string', () => {
    const events = replay([['error', errorNotification('Usage limit reached')]]);
    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'vendor-error',
          message: 'Usage limit reached',
          vendorCode: 'usageLimitExceeded',
          retryable: false,
        },
      },
    ]);
  });

  it('reports a failed turn as an error rather than a completion', () => {
    const events = replay([
      [
        'turn/completed',
        turnCompleted('failed', {
          message: 'model refused',
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
          additionalDetails: null,
        }),
      ],
    ]);
    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'vendor-turn-failed',
          message: 'model refused',
          vendorCode: 'httpConnectionFailed',
        },
      },
    ]);
  });

  /**
   * An interrupted turn is not a failed one (#812). It used to report as an
   * `error`, which put a red failure in the transcript for something that
   * merely stopped early.
   *
   * The order is load-bearing rather than cosmetic: `cancelled` says *why* and
   * `completed` is the terminal a hub predating the marker already knows how to
   * end a turn on. Emitting only the marker would leave such a hub waiting
   * forever on a terminal kind it drops — the failure #988 records.
   */
  it('reports an interrupted turn as a cancellation marker and then a completion', () => {
    const events = replay([['turn/completed', turnCompleted('interrupted')]]);

    expect(events).toEqual([{ type: 'cancelled' }, { type: 'completed' }]);
  });

  it('drops an additive item with no id rather than failing the turn on it', () => {
    // The escape hatch cannot invent the one field it needs. Every item type at
    // the pinned version carries an id; tolerating an unknown `type` is only
    // meaningful if a newer Codex that does not is survivable too.
    const noId = { type: 'quantumTool' } as never;
    const events = replay([
      ['item/started', itemStarted(noId)],
      ['item/completed', itemCompleted(noId)],
      ['turn/completed', turnCompleted()],
    ]);

    expect(events).toEqual([{ type: 'completed' }]);
    // The real failure was downstream: a `callId` of undefined threw inside
    // normalization, which the supervisor turns into a dead turn.
    expect(() => events.map(normalizeExternalAgentEvent)).not.toThrow();
  });

  it('omits the context window when Codex does not know the model it routed to', () => {
    const withWindow = replay([['thread/tokenUsage/updated', tokenUsageUpdated()]]);
    expect(withWindow.find((event) => event.type === 'thread_usage')).toMatchObject({
      usage: { contextWindowTokens: 272_000 },
    });

    const unknown = tokenUsageUpdated();
    const events = replay([
      [
        'thread/tokenUsage/updated',
        { ...unknown, tokenUsage: { ...unknown.tokenUsage, modelContextWindow: null } },
      ],
    ]);
    const threadUsage = events.find((event) => event.type === 'thread_usage');
    // Absent, not zero: the composer reads a missing window as "no percentage
    // to show", and a 0 would divide the ring by nothing.
    expect(threadUsage && 'usage' in threadUsage ? threadUsage.usage : {}).not.toHaveProperty(
      'contextWindowTokens'
    );
  });

  it('ignores an unknown additive notification instead of throwing', () => {
    expect(() =>
      replay([
        ['thread/somethingEntirelyNew', { threadId: 'x', turnId: TURN_ID }],
        ['thread/tokenUsage/updated', tokenUsageUpdated()],
      ])
    ).not.toThrow();
  });
});
