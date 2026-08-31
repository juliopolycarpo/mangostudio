/**
 * One turn status for every provider: MangoStudio's own harness has no turn
 * record and is known to be running only while this session streams, while a
 * vendor turn keeps its record across a reload. Both must read the same, and
 * the exclusions that keep a redundant "Working" row off the screen must
 * survive being lifted out of the renderer.
 */

import { describe, expect, it } from 'bun:test';
import type {
  ExternalActivityPart,
  ExternalApprovalPart,
  ExternalTurnPart,
  MessagePart,
} from '@mangostudio/shared/types';
import { deriveTurnStatus, type TurnPhase } from '@/features/chat/lib/turn-status';

function turnPart(overrides: Partial<ExternalTurnPart> = {}): ExternalTurnPart {
  return {
    type: 'external_turn',
    version: 1,
    targetId: 'codex',
    sessionId: 'session-1',
    status: 'active',
    startedAt: 0,
    updatedAt: 0,
    lastSequence: 1,
    eventCount: 1,
    persistedBytes: 10,
    ...overrides,
  };
}

function activityPart(overrides: Partial<ExternalActivityPart> = {}): ExternalActivityPart {
  return {
    type: 'external_activity',
    targetId: 'codex',
    callId: 'call-1',
    name: 'shell',
    kind: 'command',
    title: 'bun run build',
    status: 'completed',
    ...overrides,
  };
}

function approvalPart(overrides: Partial<ExternalApprovalPart> = {}): ExternalApprovalPart {
  return {
    type: 'external_approval',
    targetId: 'codex',
    requestId: 'req-1',
    kind: 'command',
    title: 'Run `rm -rf build`',
    options: [{ id: 'approve', rawLabel: 'Approve', isDestructive: false }],
    expiresAtMs: 600_000,
    ...overrides,
  };
}

const TEXT: MessagePart = { type: 'text', text: 'answer' };
const THINKING: MessagePart = { type: 'thinking', text: 'considering' };
const TOOL_CALL: MessagePart = {
  type: 'tool_call',
  toolCallId: 'call-1',
  name: 'search',
  args: {},
};

describe('deriveTurnStatus: an internal turn, with no turn record to consult', () => {
  it('shows the working row before the first part arrives', () => {
    expect(deriveTurnStatus([], true).showWorkingRow).toBe(true);
  });

  it('shows the working row in the gap after a tool call', () => {
    expect(deriveTurnStatus([TOOL_CALL], true).showWorkingRow).toBe(true);
  });

  it('leaves the row to the caret once text is streaming', () => {
    expect(deriveTurnStatus([TEXT], true).showWorkingRow).toBe(false);
  });

  it('settles the moment streaming stops', () => {
    expect(deriveTurnStatus([TOOL_CALL], false)).toEqual({
      phase: 'settled',
      livePartIndex: null,
      showWorkingRow: false,
    });
  });
});

describe('deriveTurnStatus: the three working-row exclusions', () => {
  it('excludes trailing live text, which already shows its own caret', () => {
    expect(deriveTurnStatus([TOOL_CALL, TEXT], true).showWorkingRow).toBe(false);
  });

  it('excludes trailing live thinking, which already pulses', () => {
    expect(deriveTurnStatus([TOOL_CALL, THINKING], true).showWorkingRow).toBe(false);
  });

  it('excludes a running activity, which would read as a second thing happening', () => {
    const parts = [turnPart(), activityPart({ status: 'running' })];
    expect(deriveTurnStatus(parts, true).showWorkingRow).toBe(false);
  });

  it('excludes an unanswered approval, which is waiting on the user, not the agent', () => {
    const parts = [turnPart(), approvalPart()];
    expect(deriveTurnStatus(parts, true).showWorkingRow).toBe(false);
  });

  it('restores the row once the approval is answered', () => {
    const parts = [turnPart(), approvalPart({ decisionSource: 'user', decision: 'approve' })];
    expect(deriveTurnStatus(parts, true).showWorkingRow).toBe(true);
  });

  it('restores the row once the activity finishes', () => {
    const parts = [turnPart(), activityPart({ status: 'completed' })];
    expect(deriveTurnStatus(parts, true).showWorkingRow).toBe(true);
  });
});

interface PhaseCase {
  readonly reason: string;
  readonly parts: readonly MessagePart[];
  readonly isStreaming: boolean;
  readonly phase: TurnPhase;
}

const PHASE_CASES: readonly PhaseCase[] = [
  {
    reason: 'nothing says the turn is open',
    parts: [TEXT],
    isStreaming: false,
    phase: 'settled',
  },
  {
    reason: 'an unanswered approval outranks anything the agent might be doing',
    parts: [turnPart(), approvalPart()],
    isStreaming: true,
    phase: 'awaiting-user',
  },
  {
    reason: 'tokens are landing in a thinking part',
    parts: [THINKING],
    isStreaming: true,
    phase: 'thinking',
  },
  {
    reason: 'tokens are landing in a text part',
    parts: [TEXT],
    isStreaming: true,
    phase: 'responding',
  },
  {
    reason: 'no part describes the gap the turn is in',
    parts: [TOOL_CALL],
    isStreaming: true,
    phase: 'working',
  },
];

describe('deriveTurnStatus: phase, first match wins', () => {
  for (const { reason, parts, isStreaming, phase } of PHASE_CASES) {
    it(`reports ${phase} when ${reason}`, () => {
      expect(deriveTurnStatus(parts, isStreaming).phase).toBe(phase);
    });
  }

  it('keeps a settled turn settled even with an approval nobody answered', () => {
    const parts = [turnPart({ status: 'terminal' }), approvalPart({ decisionSource: 'expired' })];
    expect(deriveTurnStatus(parts, false).phase).toBe('settled');
  });
});

describe('deriveTurnStatus: livePartIndex claims this session is receiving tokens', () => {
  it('points at the trailing text part being streamed into', () => {
    expect(deriveTurnStatus([TOOL_CALL, TEXT], true).livePartIndex).toBe(1);
  });

  it('points at the trailing thinking part being streamed into', () => {
    expect(deriveTurnStatus([TOOL_CALL, THINKING], true).livePartIndex).toBe(1);
  });

  it('stays null when the trailing part takes no tokens', () => {
    expect(deriveTurnStatus([TEXT, TOOL_CALL], true).livePartIndex).toBeNull();
  });
});

describe('deriveTurnStatus: a vendor turn reopened mid-flight', () => {
  /**
   * Today's behaviour, and the reason `running` is an OR rather than a rename:
   * the vendor's own turn record outlives the stream, so a reloaded transcript
   * still knows the turn is unfinished and still says so.
   */
  it('runs on the turn record alone, with the working row intact', () => {
    const parts = [turnPart(), TOOL_CALL];
    expect(deriveTurnStatus(parts, false)).toEqual({
      phase: 'working',
      livePartIndex: null,
      showWorkingRow: true,
    });
  });

  /**
   * The live-text exclusion is streaming-gated, so trailing text that stopped
   * growing before the reload suppresses nothing — and gets no caret either.
   */
  it('keeps the working row under text that stopped growing, and offers no caret', () => {
    const parts = [turnPart(), TEXT];
    expect(deriveTurnStatus(parts, false)).toEqual({
      phase: 'working',
      livePartIndex: null,
      showWorkingRow: true,
    });
  });

  it('still waits on the user when the reloaded approval is unanswered', () => {
    const parts = [turnPart(), approvalPart()];
    expect(deriveTurnStatus(parts, false)).toEqual({
      phase: 'awaiting-user',
      livePartIndex: null,
      showWorkingRow: false,
    });
  });

  it('settles once the vendor marks the turn terminal', () => {
    const parts = [turnPart({ status: 'terminal', terminalReason: 'completed' }), TEXT];
    expect(deriveTurnStatus(parts, false).phase).toBe('settled');
  });
});

/**
 * The internal-turn counterpart of an unanswered approval. Widening `running`
 * to MangoStudio's own harness is what made this reachable: an internal turn
 * has no `external_approval`, but it does block on a pending `mcp_elicitation`
 * while the tool call that raised it waits, and `isGenerating` stays true the
 * whole time.
 */
describe('deriveTurnStatus — a turn stopped on an MCP elicitation', () => {
  const pendingElicitation: MessagePart = {
    type: 'mcp_elicitation',
    elicitationId: 'e1',
    toolCallId: 't1',
    serverSlug: 'files',
    message: 'Which folder?',
    fields: [],
    status: 'pending',
  };

  it('is waiting on the user, not working', () => {
    const status = deriveTurnStatus([pendingElicitation], true);

    expect(status.phase).toBe('awaiting-user');
    expect(status.showWorkingRow).toBe(false);
  });

  /** Once answered it is the agent's turn again, so the filler row comes back. */
  it('goes back to working once the elicitation is answered', () => {
    const status = deriveTurnStatus([{ ...pendingElicitation, status: 'accepted' }], true);

    expect(status.phase).toBe('working');
    expect(status.showWorkingRow).toBe(true);
  });
});
