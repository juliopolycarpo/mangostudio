import { describe, expect, it } from 'bun:test';
import { RemoteError } from '@mangostudio/protocol';
import {
  backoffDelay,
  clampRetryHint,
  classifySubmissionFailure,
  DEFAULT_RETRY_POLICY,
  failureClosedConnection,
  retryHintOf,
} from '../../../../src/modules/external-agents/domain/external-turn-retry-policy';
import { RuntimeRequestNotSentError } from '../../../../src/services/runtime-client/request-not-sent';
import { ToolExecutionTimedOutError } from '../../../../src/services/tools/execution-timeout';

describe('clampRetryHint (i)', () => {
  const base = { computedDelayMs: 1_000, maxDelayMs: 30_000, nowMs: 10_000 };

  it('never lets a hint shorten the computed delay', () => {
    expect(clampRetryHint({ ...base, hintAtMs: 10_200 })).toBe(1_000);
  });

  it('lets a hint lengthen the wait, resolved against the current clock', () => {
    expect(clampRetryHint({ ...base, hintAtMs: 15_000 })).toBe(5_000);
  });

  it('never lets a hint stretch the wait past the cap', () => {
    expect(clampRetryHint({ ...base, hintAtMs: 10_000 + 3_600_000 })).toBe(30_000);
  });

  it('ignores a hint in the past, a missing one and a non-finite one', () => {
    expect(clampRetryHint({ ...base, hintAtMs: 1 })).toBe(1_000);
    expect(clampRetryHint(base)).toBe(1_000);
    expect(clampRetryHint({ ...base, hintAtMs: Number.POSITIVE_INFINITY })).toBe(1_000);
  });

  it('caps a computed delay that already exceeds the cap', () => {
    expect(clampRetryHint({ ...base, computedDelayMs: 90_000 })).toBe(30_000);
  });
});

describe('backoffDelay', () => {
  it('doubles from the base, jitters within [75%, 100%] and never exceeds the cap', () => {
    expect(backoffDelay(0, DEFAULT_RETRY_POLICY, () => 0)).toBe(750);
    expect(backoffDelay(0, DEFAULT_RETRY_POLICY, () => 1)).toBe(1_000);
    expect(backoffDelay(3, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(7_000);
    expect(backoffDelay(10_000, DEFAULT_RETRY_POLICY, () => 1)).toBe(30_000);
  });
});

describe('classifySubmissionFailure', () => {
  it('replays only a proven not-submitted failure', () => {
    expect(
      classifySubmissionFailure(new RuntimeRequestNotSentError('external-agent.turn', undefined))
    ).toBe('not-submitted');
    expect(
      classifySubmissionFailure(
        new RemoteError('UNAVAILABLE', 'busy', { dispatch: 'not-submitted' })
      )
    ).toBe('not-submitted');
  });

  it('treats a timeout and a closed connection as sent without a reply', () => {
    expect(classifySubmissionFailure(new ToolExecutionTimedOutError('late'))).toBe('no-reply');
    expect(
      classifySubmissionFailure(
        new RemoteError('UNAVAILABLE', 'closed', { id: 'r-1', closeCode: 1001 })
      )
    ).toBe('no-reply');
  });

  it('treats any other runtime answer as a committed refusal', () => {
    expect(classifySubmissionFailure(new RemoteError('VENDOR_REFUSED', 'no'))).toBe('refused');
    expect(classifySubmissionFailure(new Error('boom'))).toBe('refused');
  });

  it('reads a close code as proof the connection is gone', () => {
    expect(
      failureClosedConnection(new RemoteError('UNAVAILABLE', 'closed', { closeCode: 1001 }))
    ).toBe(true);
    expect(failureClosedConnection(new ToolExecutionTimedOutError('late'))).toBe(false);
  });

  it('reads a retry hint only from details.retryAfterMs', () => {
    expect(retryHintOf(new RemoteError('UNAVAILABLE', 'busy', { retryAfterMs: 1_700 }))).toBe(
      1_700
    );
    expect(
      retryHintOf(new RemoteError('UNAVAILABLE', 'busy', { retryAfterMs: 'soon' }))
    ).toBeUndefined();
  });
});
