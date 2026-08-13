import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';

import {
  applyToolExecutionTransition,
  canTransitionToolExecution,
  createToolExecutionSnapshot,
  inferToolExecutionSource,
  isActiveToolExecutionStatus,
  isTerminalToolExecutionStatus,
  resolveToolCallStatus,
  TOOL_EXECUTION_STATUSES,
  type ToolExecutionSnapshot,
  ToolExecutionSnapshotSchema,
  type ToolExecutionStatus,
} from '../../src/tool-executions';

const VALID_EDGES: ReadonlyArray<[ToolExecutionStatus, ToolExecutionStatus]> = [
  ['queued', 'running'],
  ['queued', 'succeeded'],
  ['queued', 'failed'],
  ['queued', 'cancelled'],
  ['queued', 'timed_out'],
  ['running', 'awaiting_user'],
  ['running', 'succeeded'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['running', 'timed_out'],
  ['awaiting_user', 'running'],
  ['awaiting_user', 'succeeded'],
  ['awaiting_user', 'failed'],
  ['awaiting_user', 'cancelled'],
  ['awaiting_user', 'timed_out'],
];

function isValidEdge(from: ToolExecutionStatus, to: ToolExecutionStatus): boolean {
  return VALID_EDGES.some(([f, t]) => f === from && t === to);
}

function snapshotWithStatus(status: ToolExecutionStatus): ToolExecutionSnapshot {
  let snapshot = createToolExecutionSnapshot('builtin', 1_000);
  if (status === 'queued') return snapshot;
  snapshot = applyToolExecutionTransition(snapshot, { status: 'running', at: 1_001 });
  if (status === 'running') return snapshot;
  if (status === 'awaiting_user') {
    return applyToolExecutionTransition(snapshot, { status: 'awaiting_user', at: 1_002 });
  }
  return applyToolExecutionTransition(snapshot, { status, at: 1_003, durationMs: 2 });
}

describe('tool execution transition table', () => {
  it('accepts exactly the documented edges across the full matrix', () => {
    for (const from of TOOL_EXECUTION_STATUSES) {
      for (const to of TOOL_EXECUTION_STATUSES) {
        expect(canTransitionToolExecution(from, to), `${from} -> ${to}`).toBe(
          isValidEdge(from, to)
        );
      }
    }
  });

  it('leaves the snapshot unchanged for every invalid edge', () => {
    for (const from of TOOL_EXECUTION_STATUSES) {
      const snapshot = snapshotWithStatus(from);
      for (const to of TOOL_EXECUTION_STATUSES) {
        if (isValidEdge(from, to)) continue;
        const next = applyToolExecutionTransition(snapshot, { status: to, at: 9_999 });
        expect(next, `${from} -> ${to}`).toBe(snapshot);
      }
    }
  });

  it('keeps terminal states immutable (first terminal transition wins)', () => {
    const failed = snapshotWithStatus('failed');
    for (const to of TOOL_EXECUTION_STATUSES) {
      expect(applyToolExecutionTransition(failed, { status: to, at: 9_999 })).toBe(failed);
    }
    expect(isTerminalToolExecutionStatus(failed.status)).toBe(true);
  });

  it('stamps the timestamp matching each target state', () => {
    let snapshot = createToolExecutionSnapshot('mcp', 1_000);
    expect(snapshot).toEqual({ status: 'queued', source: 'mcp', queuedAt: 1_000 });

    snapshot = applyToolExecutionTransition(snapshot, { status: 'running', at: 1_010 });
    expect(snapshot.startedAt).toBe(1_010);

    snapshot = applyToolExecutionTransition(snapshot, { status: 'awaiting_user', at: 1_020 });
    expect(snapshot.awaitingUserAt).toBe(1_020);

    // Resuming does not overwrite the original start time.
    snapshot = applyToolExecutionTransition(snapshot, { status: 'running', at: 1_030 });
    expect(snapshot.startedAt).toBe(1_010);

    snapshot = applyToolExecutionTransition(snapshot, {
      status: 'succeeded',
      at: 1_040,
      durationMs: 30.4,
    });
    expect(snapshot.finishedAt).toBe(1_040);
    expect(snapshot.durationMs).toBe(30);
    expect(snapshot.reasonCode).toBeUndefined();
  });

  it('records the reason code only on terminal transitions', () => {
    const running = snapshotWithStatus('running');
    const awaiting = applyToolExecutionTransition(running, {
      status: 'awaiting_user',
      at: 2_000,
      reasonCode: 'timeout',
    });
    expect(awaiting.reasonCode).toBeUndefined();

    const timedOut = applyToolExecutionTransition(awaiting, {
      status: 'timed_out',
      at: 2_001,
      durationMs: 5,
      reasonCode: 'timeout',
    });
    expect(timedOut.reasonCode).toBe('timeout');
  });

  it('produces schema-valid snapshots at every stage', () => {
    for (const status of TOOL_EXECUTION_STATUSES) {
      const snapshot = snapshotWithStatus(status);
      expect(Value.Check(ToolExecutionSnapshotSchema, snapshot), status).toBe(true);
    }
  });
});

describe('resolveToolCallStatus', () => {
  it('prefers a terminal snapshot over the result-derived state', () => {
    const cancelled = snapshotWithStatus('cancelled');
    expect(
      resolveToolCallStatus({ execution: cancelled, hasResult: true, isStreaming: false })
    ).toBe('cancelled');
  });

  it('keeps live states while streaming and settles them on reload', () => {
    const running = snapshotWithStatus('running');
    expect(resolveToolCallStatus({ execution: running, hasResult: false, isStreaming: true })).toBe(
      'running'
    );
    expect(
      resolveToolCallStatus({ execution: running, hasResult: false, isStreaming: false })
    ).toBe('cancelled');
    expect(
      resolveToolCallStatus({
        execution: running,
        hasResult: true,
        isError: true,
        isStreaming: false,
      })
    ).toBe('failed');
  });

  it('maps legacy parts without a snapshot from their result', () => {
    expect(resolveToolCallStatus({ hasResult: true, isError: false, isStreaming: false })).toBe(
      'succeeded'
    );
    expect(resolveToolCallStatus({ hasResult: true, isError: true, isStreaming: false })).toBe(
      'failed'
    );
    expect(resolveToolCallStatus({ hasResult: false, isStreaming: true })).toBe('running');
    expect(resolveToolCallStatus({ hasResult: false, isStreaming: false })).toBe('cancelled');
  });
});

describe('status helpers', () => {
  it('classifies active vs terminal statuses', () => {
    expect(isActiveToolExecutionStatus('queued')).toBe(true);
    expect(isActiveToolExecutionStatus('running')).toBe(true);
    expect(isActiveToolExecutionStatus('awaiting_user')).toBe(true);
    for (const status of ['succeeded', 'failed', 'cancelled', 'timed_out'] as const) {
      expect(isActiveToolExecutionStatus(status)).toBe(false);
      expect(isTerminalToolExecutionStatus(status)).toBe(true);
    }
  });

  it('infers a display source for legacy part names', () => {
    expect(inferToolExecutionSource('mcp__files__read_resource')).toBe('mcp');
    expect(inferToolExecutionSource('skill')).toBe('skill');
    expect(inferToolExecutionSource('delegate_to_agent')).toBe('subagent');
    expect(inferToolExecutionSource('read_file')).toBe('builtin');
  });
});
