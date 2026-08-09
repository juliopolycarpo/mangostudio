import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExternalAgentEvent } from '@mangostudio/shared/external-agents';
import { CodexTurnReducer } from '../../../src/services/external-agents/codex/reducer';
import {
  agentMessageDelta,
  agentMessageItem,
  commandExecutionItem,
  errorNotification,
  fileChangeItem,
  itemCompleted,
  itemStarted,
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
      { type: 'completed' },
    ]);
    expect(reducer.finished).toBe(true);
  });

  it('captures usage before the turn ends, not after it', () => {
    const usageIndex = transcript.findIndex(
      (frame) => frame.method === 'thread/tokenUsage/updated'
    );
    const completedIndex = transcript.findIndex((frame) => frame.method === 'turn/completed');
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeLessThan(completedIndex);
  });
});

describe('codex reducer — item correlation', () => {
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

  it('drops the user message echo so the transcript is not duplicated', () => {
    const events = replay([
      ['item/started', itemStarted(userMessageItem('echo', 'hello'))],
      ['item/completed', itemCompleted(userMessageItem('echo', 'hello'))],
    ]);
    expect(events).toEqual([]);
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

  it('ignores an unknown additive notification instead of throwing', () => {
    expect(() =>
      replay([
        ['thread/somethingEntirelyNew', { threadId: 'x', turnId: TURN_ID }],
        ['thread/tokenUsage/updated', tokenUsageUpdated()],
      ])
    ).not.toThrow();
  });
});
