import { expect } from 'bun:test';
import type { ContinuationReasonCode, ProviderType } from '@mangostudio/shared/types';
import {
  type ContinuationEnvelope,
  type ContinuationMode,
  parseContinuationEnvelope,
} from '../../../src/services/providers/core/continuation-envelope';
import type { AgentEvent } from '../../../src/services/providers/types';

export interface ExpectedEnvelope {
  provider: ProviderType;
  mode: ContinuationMode;
  cursor?: string;
  providerReportedInputTokens?: number;
}

/**
 * Finds the `turn_completed` event in an event array and returns its
 * raw providerState string, or undefined when no such event exists.
 */
export function findTurnCompletedProviderState(events: AgentEvent[]): string | undefined {
  const completed = events.find(
    (e): e is AgentEvent & { type: 'turn_completed' } => e.type === 'turn_completed'
  );
  return completed?.providerState;
}

/**
 * Asserts that a `turn_completed` event exists and its providerState
 * parses to a valid `ContinuationEnvelope` matching the expected shape.
 */
export function expectTurnCompletedEnvelope(
  events: AgentEvent[],
  expected: ExpectedEnvelope
): ContinuationEnvelope | null {
  const providerState = findTurnCompletedProviderState(events);
  expect(providerState).toBeDefined();

  const envelope = parseContinuationEnvelope(providerState);
  expect(envelope).not.toBeNull();
  if (envelope === null) return null;

  expect(envelope.provider).toBe(expected.provider);
  expect(envelope.mode).toBe(expected.mode);

  if (expected.cursor !== undefined) {
    expect(envelope.cursor).toBe(expected.cursor);
  }
  if (expected.providerReportedInputTokens !== undefined) {
    expect(envelope.context?.providerReportedInputTokens).toBe(
      expected.providerReportedInputTokens
    );
  }

  return envelope;
}

/**
 * Asserts that a `continuation_degraded` event exists with the
 * expected from/to mode and reason code.
 */
export function expectContinuationDegraded(
  events: AgentEvent[],
  expected: { from: string; to: string; reasonCode: ContinuationReasonCode }
): void {
  const degraded = events.find(
    (e): e is AgentEvent & { type: 'continuation_degraded' } => e.type === 'continuation_degraded'
  );
  expect(degraded).toBeDefined();
  if (degraded === undefined) return;
  expect(degraded.from).toBe(expected.from);
  expect(degraded.to).toBe(expected.to);
  expect(degraded.reasonCode).toBe(expected.reasonCode);
}

/**
 * Asserts that a `turn_error` event exists and returns its error message.
 */
export function expectTurnError(events: AgentEvent[]): string | undefined {
  const error = events.find(
    (e): e is AgentEvent & { type: 'turn_error' } => e.type === 'turn_error'
  );
  expect(error).toBeDefined();
  return error?.error;
}

/**
 * Asserts that no `turn_error` event exists in the event array.
 */
export function expectNoTurnError(events: AgentEvent[]): void {
  expect(events.some((e) => e.type === 'turn_error')).toBe(false);
}
