import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolCallGroupBlock } from '@/features/chat/components/ToolCallGroupBlock';
import type { ToolCallEntry } from '@/features/chat/components/tool-call-grouping';
import { render } from '../../support/harness/render';

function entry(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    toolCallId: 't1',
    name: 'read_file',
    args: { path: '/home/polycarpo/a.ts' },
    result: '{"content":"a"}',
    status: 'succeeded',
    isPending: false,
    ...overrides,
  };
}

describe('ToolCallGroupBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('summarizes the run with the label, first path, and remaining count', () => {
    render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1', args: { path: '/home/polycarpo/a.ts' } }),
          entry({ toolCallId: 't2', args: { path: '/home/polycarpo/b.ts' } }),
          entry({ toolCallId: 't3', args: { path: '/home/polycarpo/c.ts' } }),
        ]}
      />
    );

    const summary = screen.getByRole('button');
    expect(summary).toHaveTextContent(/Read/i);
    expect(summary).toHaveTextContent('~/a.ts');
    expect(summary).toHaveTextContent('+2 more');
  });

  it('expands to reveal one child block per call', () => {
    render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1', args: { path: '/home/polycarpo/a.ts' } }),
          entry({ toolCallId: 't2', args: { path: '/home/polycarpo/b.ts' } }),
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button'));

    // Summary button + two child tool-call buttons.
    expect(screen.getAllByRole('button')).toHaveLength(3);
    const child = screen.getByText('~/b.ts').closest('button');
    expect(child).not.toBeNull();
    fireEvent.click(child as HTMLElement);
    const childRegion = (child as HTMLElement).parentElement as HTMLElement;
    expect(within(childRegion).getByText('args')).toBeInTheDocument();
  });

  it('shows an error tone when any call failed', () => {
    render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1' }),
          entry({ toolCallId: 't2', isError: false, status: 'failed', result: 'denied' }),
        ]}
      />
    );

    expect(screen.getByRole('button').className).toContain('text-error');
  });

  it('shows a neutral tone when any call was cancelled and none failed', () => {
    const { container } = render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1' }),
          entry({ toolCallId: 't2', status: 'cancelled', isPending: false }),
        ]}
      />
    );

    const summary = screen.getByRole('button');
    expect(summary.className).toContain('text-on-surface-variant');
    expect(summary.className).not.toContain('text-success');
    expect(container.querySelector('.lucide-ban')).toBeInTheDocument();
    expect(container.querySelector('.lucide-circle-check-big')).not.toBeInTheDocument();
  });

  it('shows an error tone when any call timed out', () => {
    render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1' }),
          entry({ toolCallId: 't2', status: 'timed_out', isError: false }),
        ]}
      />
    );

    expect(screen.getByRole('button').className).toContain('text-error');
  });

  it('shows a pending tone when any call awaits user input', () => {
    render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1' }),
          entry({ toolCallId: 't2', status: 'awaiting_user', isPending: false }),
        ]}
      />
    );

    expect(screen.getByRole('button').className).toContain('text-primary');
  });
});
