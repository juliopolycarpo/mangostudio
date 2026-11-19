import { describe, expect, it } from 'bun:test';

import Value from 'typebox/value';

import {
  applyToolExecutionTransition,
  createToolExecutionSnapshot,
  resolveToolCallRetryEligibility,
  RetryToolCallBodySchema,
  TOOL_RETRY_SAFETY_VALUES,
  type ToolCallRetryEligibility,
  type ToolExecutionReasonCode,
  ToolExecutionSnapshotSchema,
  type ToolExecutionStatus,
  type ToolRetrySafety,
  TOOLS_NEEDING_A_MODEL_TURN,
} from '../../src/tool-executions';

type Row = {
  readonly status: ToolExecutionStatus;
  readonly reasonCode?: ToolExecutionReasonCode;
  readonly retrySafety?: ToolRetrySafety;
  readonly expected: ToolCallRetryEligibility;
};

const OFFER_DIRECT: ToolCallRetryEligibility = { eligible: true, confirmation: 'none' };
const OFFER_CONFIRMED: ToolCallRetryEligibility = { eligible: true, confirmation: 'required' };
const refused = (
  reason: 'not_terminal' | 'same_refusal' | 'no_policy'
): ToolCallRetryEligibility => ({
  eligible: false,
  reason,
});

const ROWS: readonly Row[] = [
  // Terminal states that offer a retry: safe_read runs directly, the rest confirm.
  {
    status: 'failed',
    reasonCode: 'execution_error',
    retrySafety: 'safe_read',
    expected: OFFER_DIRECT,
  },
  {
    status: 'failed',
    reasonCode: 'server_closed',
    retrySafety: 'safe_read',
    expected: OFFER_DIRECT,
  },
  {
    status: 'cancelled',
    reasonCode: 'user_cancelled',
    retrySafety: 'safe_read',
    expected: OFFER_DIRECT,
  },
  {
    status: 'cancelled',
    reasonCode: 'turn_aborted',
    retrySafety: 'safe_read',
    expected: OFFER_DIRECT,
  },
  { status: 'timed_out', reasonCode: 'timeout', retrySafety: 'safe_read', expected: OFFER_DIRECT },
  {
    status: 'failed',
    reasonCode: 'execution_error',
    retrySafety: 'confirmation_required',
    expected: OFFER_CONFIRMED,
  },
  {
    status: 'cancelled',
    reasonCode: 'user_cancelled',
    retrySafety: 'confirmation_required',
    expected: OFFER_CONFIRMED,
  },
  {
    status: 'timed_out',
    reasonCode: 'timeout',
    retrySafety: 'confirmation_required',
    expected: OFFER_CONFIRMED,
  },
  {
    status: 'failed',
    reasonCode: 'execution_error',
    retrySafety: 'unknown',
    expected: OFFER_CONFIRMED,
  },
  { status: 'timed_out', reasonCode: 'timeout', retrySafety: 'unknown', expected: OFFER_CONFIRMED },
  // The call may have taken effect, so even a read asks first.
  {
    status: 'cancelled',
    reasonCode: 'outcome_unknown',
    retrySafety: 'safe_read',
    expected: OFFER_CONFIRMED,
  },
  {
    status: 'cancelled',
    reasonCode: 'outcome_unknown',
    retrySafety: 'confirmation_required',
    expected: OFFER_CONFIRMED,
  },
  {
    status: 'failed',
    reasonCode: 'outcome_unknown',
    retrySafety: 'safe_read',
    expected: OFFER_CONFIRMED,
  },
  // Same inputs, same refusal.
  {
    status: 'failed',
    reasonCode: 'not_allowed',
    retrySafety: 'safe_read',
    expected: refused('same_refusal'),
  },
  {
    status: 'failed',
    reasonCode: 'tool_disabled',
    retrySafety: 'safe_read',
    expected: refused('same_refusal'),
  },
  {
    status: 'failed',
    reasonCode: 'unknown_tool',
    retrySafety: 'safe_read',
    expected: refused('same_refusal'),
  },
  {
    status: 'failed',
    reasonCode: 'validation_failed',
    retrySafety: 'safe_read',
    expected: refused('same_refusal'),
  },
  {
    status: 'failed',
    reasonCode: 'validation_failed',
    retrySafety: 'unknown',
    expected: refused('same_refusal'),
  },
  // Not a terminal failure.
  { status: 'succeeded', retrySafety: 'safe_read', expected: refused('not_terminal') },
  { status: 'queued', retrySafety: 'safe_read', expected: refused('not_terminal') },
  { status: 'running', retrySafety: 'safe_read', expected: refused('not_terminal') },
  { status: 'awaiting_user', retrySafety: 'safe_read', expected: refused('not_terminal') },
  // No recorded policy (it never started, or predates the field): nothing to judge a retry by.
  { status: 'failed', reasonCode: 'execution_error', expected: refused('no_policy') },
];

describe('resolveToolCallRetryEligibility', () => {
  for (const row of ROWS) {
    const label = `${row.status} / ${row.reasonCode ?? 'no reason'} / ${row.retrySafety ?? 'no safety'}`;
    it(`${label} -> ${JSON.stringify(row.expected)}`, () => {
      expect(
        resolveToolCallRetryEligibility({
          name: 'read_file',
          status: row.status,
          reasonCode: row.reasonCode,
          retrySafety: row.retrySafety,
        })
      ).toEqual(row.expected);
    });
  }

  it.each([...TOOLS_NEEDING_A_MODEL_TURN])(
    'never offers %s, which a tool-only run cannot finish',
    (name) => {
      expect(
        resolveToolCallRetryEligibility({
          name,
          status: 'failed',
          reasonCode: 'execution_error',
          retrySafety: 'confirmation_required',
        })
      ).toEqual({ eligible: false, reason: 'needs_model' });
    }
  );

  it('covers every retry safety value in the table', () => {
    const seen = new Set(ROWS.map((row) => row.retrySafety).filter(Boolean));
    for (const value of TOOL_RETRY_SAFETY_VALUES) {
      expect(seen.has(value), `retry safety ${value} has no row`).toBe(true);
    }
  });
});

describe('retry safety on the lifecycle snapshot', () => {
  it('records the policy when the call first starts running and never rewrites it', () => {
    const queued = createToolExecutionSnapshot('builtin', 1);
    const running = applyToolExecutionTransition(queued, {
      status: 'running',
      at: 2,
      retrySafety: 'confirmation_required',
    });
    expect(running.retrySafety).toBe('confirmation_required');

    const awaiting = applyToolExecutionTransition(running, { status: 'awaiting_user', at: 3 });
    const resumed = applyToolExecutionTransition(awaiting, {
      status: 'running',
      at: 4,
      retrySafety: 'safe_read',
    });
    expect(resumed.retrySafety).toBe('confirmation_required');
    expect(Value.Check(ToolExecutionSnapshotSchema, resumed)).toBe(true);
  });

  it('rejects a retry safety outside the shared vocabulary', () => {
    const snapshot = { ...createToolExecutionSnapshot('builtin', 1), retrySafety: 'probably_fine' };
    expect(Value.Check(ToolExecutionSnapshotSchema, snapshot)).toBe(false);
  });
});

describe('RetryToolCallBodySchema', () => {
  it('accepts an empty body and an explicit confirmation', () => {
    expect(Value.Check(RetryToolCallBodySchema, {})).toBe(true);
    expect(Value.Check(RetryToolCallBodySchema, { confirmed: true })).toBe(true);
  });

  it('rejects a confirmation that is not a boolean', () => {
    expect(Value.Check(RetryToolCallBodySchema, { confirmed: 'yes' })).toBe(false);
  });
});
