import { describe, expect, it, jest } from 'bun:test';

import type { TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  agentId: 'default',
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
    const onResume = jest.fn().mockResolvedValue(undefined);
    render(
      <InterruptedTurnNotice
        messageId="message-1"
        checkpoint={CHECKPOINT}
        disabled={false}
        onResume={onResume}
        onDismiss={jest.fn().mockResolvedValue(undefined)}
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

  // The checkbox keeps its 16px box on a touch screen, so the row around it has
  // to be the 44px tap target the global rule used to force on the input.
  it('keeps a 44px row to tap on a touch screen around the 16px checkbox', () => {
    render(
      <InterruptedTurnNotice
        messageId="message-1"
        checkpoint={CHECKPOINT}
        disabled={false}
        onResume={jest.fn().mockResolvedValue(undefined)}
        onDismiss={jest.fn().mockResolvedValue(undefined)}
      />
    );

    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox.className).toContain('size-4');
      expect(checkbox.closest('label')?.className).toContain('pointer-coarse:min-h-11');
    }
  });

  // A check on a call that failed contradicts the word beside it. The notice
  // draws the verdict marks the tool rail draws for the same calls.
  it('marks a completed call that failed with the failure glyph, not a check', () => {
    const { container } = render(
      <InterruptedTurnNotice
        messageId="message-1"
        checkpoint={{
          ...CHECKPOINT,
          completedCalls: [
            { callId: 'ok', name: 'read_file', retrySafety: 'safe_read', result: 'ok' },
            {
              callId: 'bad',
              name: 'bash',
              retrySafety: 'confirmation_required',
              result: 'exit 2',
              isError: true,
            },
          ],
        }}
        disabled={false}
        onResume={jest.fn().mockResolvedValue(undefined)}
        onDismiss={jest.fn().mockResolvedValue(undefined)}
      />
    );

    const chips = [...container.querySelectorAll('.terminal-chip')];
    const ok = chips.find((chip) => chip.textContent?.includes('read_file'));
    const bad = chips.find((chip) => chip.textContent?.includes('bash'));

    expect(ok?.querySelector('.lucide-check')).not.toBeNull();
    expect(ok?.querySelector('.lucide-circle-alert')).toBeNull();
    expect(bad?.querySelector('.lucide-circle-alert')).not.toBeNull();
    expect(bad?.querySelector('.lucide-check')).toBeNull();
    // A verdict beside a tool name, set off by a separator: capitalised and run
    // straight on, it read as one word ("bash Failed").
    expect(bad).toHaveTextContent('bash·failed');
  });

  it('dismisses the prompt without changing checkpoint evidence locally', async () => {
    const user = userEvent.setup();
    const onDismiss = jest.fn().mockResolvedValue(undefined);
    render(
      <InterruptedTurnNotice
        messageId="message-1"
        checkpoint={CHECKPOINT}
        disabled={false}
        onResume={jest.fn().mockResolvedValue(undefined)}
        onDismiss={onDismiss}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('message-1'));
    expect(CHECKPOINT.status).toBe('interrupted');
  });
});

describe('InterruptedTurnNotice — one primary action per dock', () => {
  function renderNotice(resumeVariant?: 'primary' | 'secondary') {
    return render(
      <InterruptedTurnNotice
        messageId="message-1"
        checkpoint={CHECKPOINT}
        disabled={false}
        onResume={jest.fn().mockResolvedValue(undefined)}
        onDismiss={jest.fn().mockResolvedValue(undefined)}
        resumeVariant={resumeVariant}
      />
    );
  }

  it('resumes with the accent when it is the only decision on screen', () => {
    renderNotice();

    expect(screen.getByRole('button', { name: /Resume turn/i }).className).toContain('bg-accent');
  });

  it('steps down to a secondary button while another notice already holds the accent', () => {
    renderNotice('secondary');

    const resume = screen.getByRole('button', { name: /Resume turn/i });
    expect(resume.className).not.toContain('bg-accent');
    expect(resume.className).toContain('bg-control');
  });

  it('titles itself through the callout, at the weight every other notice uses', () => {
    renderNotice();

    const title = screen.getByText('Agent turn interrupted');
    expect(title.className).toContain('font-medium');
    expect(title.className).not.toContain('font-semibold');
  });
});
