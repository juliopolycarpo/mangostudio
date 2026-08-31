/**
 * The chip names the turn's phase; the working row names the step's. They are
 * different altitudes, and exactly one of them may speak at a time.
 */

import { describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { screen } from '@testing-library/react';
import { TurnStatusChip } from '../../../src/features/chat/components/TurnStatusChip';
import { deriveTurnStatus } from '../../../src/features/chat/lib/turn-status';
import { render } from '../../support/harness/render';

function renderChip(parts: MessagePart[], isStreaming: boolean) {
  const status = deriveTurnStatus(parts, isStreaming);
  render(<TurnStatusChip phase={status.phase} showWorkingRow={status.showWorkingRow} />);
  return status;
}

/** No phase label at all — the harness mounts its own chrome, so ask by text. */
function expectNoChip() {
  for (const label of ['Working', 'Thinking', 'Responding', 'Waiting for you']) {
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  }
}

describe('TurnStatusChip', () => {
  it('says nothing about a settled turn', () => {
    renderChip([{ type: 'text', text: 'Done.' }], false);

    expectNoChip();
  });

  it('names the phase while the turn streams prose', () => {
    renderChip([{ type: 'text', text: 'Here is' }], true);

    expect(screen.getByText('Responding')).toBeInTheDocument();
  });

  it('names the phase while the turn streams a thought', () => {
    renderChip([{ type: 'thinking', text: 'weighing it' }], true);

    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });

  /**
   * The single-ownership rule. The working row is the older and more specific
   * statement, so the chip yields to it — two things saying the turn is busy, a
   * few pixels apart, read as two things happening.
   */
  it('yields to the working row rather than repeating it', () => {
    const status = renderChip(
      [{ type: 'tool_call', toolCallId: 'c1', name: 'Bash', args: {} }],
      true
    );

    expect(status.showWorkingRow).toBe(true);
    expectNoChip();
  });

  /** A turn stopped on the user is not working, and says so in its own words. */
  it('names a turn waiting on a decision only the user can make', () => {
    renderChip(
      [
        {
          type: 'external_approval',
          targetId: 'claude',
          requestId: 'r1',
          kind: 'file-change',
          title: 'Write dist/index.js',
          options: [{ id: 'approve', rawLabel: 'Approve', isDestructive: false }],
          expiresAtMs: 1_800_000_000_000,
        },
      ],
      true
    );

    expect(screen.getByText('Waiting for you')).toBeInTheDocument();
  });
});
