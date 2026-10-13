import { describe, expect, it } from 'bun:test';
import {
  EXTERNAL_AGENT_TARGET_IDS,
  EXTERNAL_TURN_TERMINAL_REASONS,
  type ExternalTurnTerminalReason,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_RESUME_POLICIES,
  endLeavesConversationUnresumable,
  resumeModeFor,
} from '../../../../src/modules/external-agents/domain/external-resume-policy';

describe('the resume policy table', () => {
  it('has a row for every target', () => {
    expect(
      Object.keys(EXTERNAL_RESUME_POLICIES).sort(),
      'expected one policy row per external agent target'
    ).toEqual([...EXTERNAL_AGENT_TARGET_IDS].sort());
  });

  it.each([
    ['claude', 'strict'],
    ['codex', 'fallback'],
    ['cursor', 'fallback'],
  ] as const)('asks %s for a %s resume', (targetId, expected) => {
    expect(
      resumeModeFor(targetId, false),
      `expected ${targetId} to resume in ${expected} mode`
    ).toBe(expected);
  });

  it.each(EXTERNAL_AGENT_TARGET_IDS)('asks %s for a strict resume of an adopted session', (id) => {
    expect(resumeModeFor(id, true)).toBe('strict');
  });
});

describe('what the end of a turn means for the stored conversation', () => {
  const ALWAYS: ExternalTurnTerminalReason[] = [
    'cancelled-by-user',
    'interrupted',
    'runtime-disconnected',
    'hub-restarted',
    'acceptance-unknown',
    'sequence-gap',
    'limit-exceeded',
    'consent-revoked',
    'session-lost',
  ];

  it('covers every terminal reason', () => {
    const decided = new Set<string>([...ALWAYS, 'completed', 'vendor-error']);
    expect(
      EXTERNAL_TURN_TERMINAL_REASONS.filter((reason) => !decided.has(reason)),
      'expected no terminal reason without a decision'
    ).toEqual([]);
  });

  it.each(ALWAYS)('marks a Claude conversation unresumable when the turn ended %s', (reason) => {
    expect(
      endLeavesConversationUnresumable('claude', reason),
      `expected a Claude turn ended ${reason} to be unresumable`
    ).toBe(true);
  });

  it('leaves a completed turn resumable', () => {
    expect(endLeavesConversationUnresumable('claude', 'completed')).toBe(false);
  });

  it.each([
    ['claude-stream-broken', true],
    ['claude-no-result', true],
    ['claude-terminated', true],
    ['claude-error', false],
    ['claude-error_during_execution', false],
    [undefined, false],
  ] as const)('treats a Claude vendor error %p as unresumable: %p', (code, expected) => {
    expect(
      endLeavesConversationUnresumable('claude', 'vendor-error', code),
      `expected vendor error ${String(code)} to be ${expected ? 'unresumable' : 'resumable'}`
    ).toBe(expected);
  });

  it.each(['codex', 'cursor'] as const)('never marks a %s conversation', (targetId) => {
    const marked = EXTERNAL_TURN_TERMINAL_REASONS.filter((reason) =>
      endLeavesConversationUnresumable(targetId, reason, 'claude-no-result')
    );
    expect(marked, `expected no reason to mark a ${targetId} conversation`).toEqual([]);
  });
});
