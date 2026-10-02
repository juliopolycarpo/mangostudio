import { describe, expect, it } from 'bun:test';
import { RemoteError } from '@mangostudio/protocol';
import {
  backoffDelay,
  classifySubmissionFailure,
  DEFAULT_RETRY_POLICY,
  failureClosedConnection,
} from '../../../../src/modules/external-agents/domain/external-turn-retry-policy';
import {
  RuntimeRequestNoReplyError,
  RuntimeRequestNotSentError,
} from '../../../../src/services/runtime-client/request-not-sent';
import { ToolExecutionTimedOutError } from '../../../../src/services/tools/execution-timeout';

describe('backoffDelay', () => {
  it('doubles from the base, jitters within [75%, 100%] and never exceeds the cap', () => {
    expect(backoffDelay(0, DEFAULT_RETRY_POLICY, () => 0)).toBe(750);
    expect(backoffDelay(0, DEFAULT_RETRY_POLICY, () => 1)).toBe(1_000);
    expect(backoffDelay(3, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(7_000);
    expect(backoffDelay(10_000, DEFAULT_RETRY_POLICY, () => 1)).toBe(30_000);
  });
});

describe('classifySubmissionFailure', () => {
  const localDeadline = () =>
    new ToolExecutionTimedOutError('late', {
      cause: new RuntimeRequestNoReplyError(new RemoteError('TIMEOUT', 'late'), 'deadline'),
    });
  const localClose = () =>
    new RuntimeRequestNoReplyError(
      new RemoteError('UNAVAILABLE', 'closed', { id: 'r-1', closeCode: 1001 }),
      'connection-closed'
    );

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

  it('treats only a hub-observed deadline or close as sent without a reply', () => {
    expect(classifySubmissionFailure(localDeadline())).toBe('no-reply');
    expect(classifySubmissionFailure(localClose())).toBe('no-reply');
  });

  it('does not replay a deterministic refusal even when nothing was submitted', () => {
    expect(
      classifySubmissionFailure(
        new RemoteError('INTERNAL', 'Input too large.', {
          kind: 'external_agent_turn_refused',
          dispatch: 'not-submitted',
        })
      )
    ).toBe('refused');
  });

  it('keeps accepted, uncertain and cleanup-bearing outcomes committed', () => {
    for (const dispatch of ['accepted', 'acceptance-unknown'] as const) {
      expect(
        classifySubmissionFailure(
          new RemoteError('INTERNAL', 'Vendor rejected input.', {
            kind: 'external_agent_turn_refused',
            dispatch,
            cleanupRequired: true,
            cleanup: 'unconfirmed',
          })
        )
      ).toBe(dispatch === 'acceptance-unknown' ? 'acceptance-unknown' : 'refused');
    }
  });

  it('does not treat cleanup-bearing deterministic markers as safe refusals or retries', () => {
    for (const details of [
      { cleanupRequired: true },
      { cleanup: 'unconfirmed' },
      { cleanupRequired: 'true' },
    ]) {
      expect(
        classifySubmissionFailure(
          new RemoteError('INTERNAL', 'Cleanup is not confirmed.', {
            kind: 'external_agent_turn_refused',
            dispatch: 'not-submitted',
            ...details,
          })
        )
      ).toBe('acceptance-unknown');
    }
  });

  it('does not confuse a malformed refusal kind with a deterministic refusal', () => {
    expect(
      classifySubmissionFailure(
        new RemoteError('INTERNAL', 'Busy.', {
          kind: ['external_agent_turn_refused'],
          dispatch: 'not-submitted',
        })
      )
    ).toBe('not-submitted');
  });

  it('keeps local no-reply provenance ahead of a carried deterministic marker', () => {
    const error = new RuntimeRequestNoReplyError(
      new RemoteError('UNAVAILABLE', 'Closed.', {
        kind: 'external_agent_turn_refused',
        dispatch: 'not-submitted',
      }),
      'connection-closed'
    );
    expect(classifySubmissionFailure(error)).toBe('no-reply');
  });

  it('treats every runtime-sent reserved code as a committed refusal', () => {
    // What the Rust runtime answers for a signed-out vendor, an SDK timeout and a cancel,
    // after RuntimeClient translated them.
    expect(classifySubmissionFailure(new RemoteError('UNAVAILABLE', 'signed out'))).toBe('refused');
    expect(
      classifySubmissionFailure(
        new ToolExecutionTimedOutError('vendor timeout', { cause: new RemoteError('TIMEOUT', 'x') })
      )
    ).toBe('refused');
    expect(classifySubmissionFailure(new DOMException('cancelled', 'AbortError'))).toBe('refused');
    expect(classifySubmissionFailure(new RemoteError('VENDOR_REFUSED', 'no'))).toBe('refused');
    expect(classifySubmissionFailure(new Error('boom'))).toBe('refused');
  });

  it("reads a runtime's own acceptance-unknown answer as unresolvable", () => {
    expect(
      classifySubmissionFailure(
        new RemoteError('UNAVAILABLE', 'link lost', { dispatch: 'acceptance-unknown' })
      )
    ).toBe('acceptance-unknown');
  });

  it('reads only a hub-observed close as proof the connection is gone', () => {
    expect(failureClosedConnection(localClose())).toBe(true);
    expect(failureClosedConnection(localDeadline())).toBe(false);
    expect(
      failureClosedConnection(new RemoteError('UNAVAILABLE', 'closed', { closeCode: 1001 }))
    ).toBe(false);
  });
});
