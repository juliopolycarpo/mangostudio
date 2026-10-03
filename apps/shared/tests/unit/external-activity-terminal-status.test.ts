import { describe, expect, it } from 'bun:test';
import {
  EXTERNAL_TURN_TERMINAL_REASONS,
  type ExternalActivityStatus,
  type ExternalTurnTerminalReason,
  externalActivityStatusForTerminal,
} from '../../src/external-agents';

const EXPECTED_STATUSES = {
  completed: 'completed',
  'cancelled-by-user': 'cancelled',
  interrupted: 'cancelled',
  'vendor-error': 'failed',
  'runtime-disconnected': 'failed',
  'hub-restarted': 'failed',
  'sequence-gap': 'failed',
  'limit-exceeded': 'failed',
  'consent-revoked': 'cancelled',
  'session-lost': 'failed',
  'acceptance-unknown': 'failed',
} satisfies Record<ExternalTurnTerminalReason, ExternalActivityStatus>;

describe('external activity terminal fallback', () => {
  it.each([...EXTERNAL_TURN_TERMINAL_REASONS])('uses the intended status for %s', (reason) => {
    expect(externalActivityStatusForTerminal(reason)).toBe(EXPECTED_STATUSES[reason]);
  });
});
