import type { TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InterruptedTurnNotice } from '@/features/chat/components/InterruptedTurnNotice';
import { render } from '../../support/harness/render';

const CHECKPOINT: TurnCheckpointPart = {
  type: 'turn_checkpoint',
  version: 1,
  turnId: 'turn-1',
  status: 'interrupted',
  reasonCode: 'server_restart',
  sequence: 3,
  startedAt: 1,
  checkpointedAt: 2,
  provider: 'openai',
  modelName: 'gpt-test',
  agentId: 'chat',
  lastAssistantText: 'partial response',
  todoSnapshot: [],
  completedCalls: [
    {
      callId: 'done-1',
      name: 'read_file',
      retrySafety: 'safe_read',
      result: 'ok',
    },
  ],
  incompleteCalls: [
    {
      callId: 'read-1',
      name: 'grep',
      retrySafety: 'safe_read',
      status: 'cancelled',
      outcome: 'interrupted',
    },
    {
      callId: 'write-1',
      name: 'write_file',
      retrySafety: 'confirmation_required',
      status: 'cancelled',
      outcome: 'unknown',
    },
    {
      callId: 'mcp-1',
      name: 'mcp__github__create_issue',
      retrySafety: 'unknown',
      status: 'cancelled',
      outcome: 'unknown',
    },
  ],
};

describe('InterruptedTurnNotice', () => {
  it('defaults only read-only retries on and submits explicit selections', async () => {
    const user = userEvent.setup();
    const onResume = vi.fn().mockResolvedValue(undefined);
    render(
      <InterruptedTurnNotice
        messageId="message-1"
        checkpoint={CHECKPOINT}
        disabled={false}
        onResume={onResume}
        onDismiss={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
    expect(checkboxes[2]).not.toBeChecked();

    await user.click(checkboxes[1]);
    await user.click(screen.getByRole('button', { name: /Resume turn/i }));

    await waitFor(() => expect(onResume).toHaveBeenCalledWith('message-1', ['read-1', 'write-1']));
  });

  it('dismisses the prompt without changing checkpoint evidence locally', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    render(
      <InterruptedTurnNotice
        messageId="message-1"
        checkpoint={CHECKPOINT}
        disabled={false}
        onResume={vi.fn().mockResolvedValue(undefined)}
        onDismiss={onDismiss}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('message-1'));
    expect(CHECKPOINT.status).toBe('interrupted');
  });
});
