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
          entry({ toolCallId: 't2', isError: true, status: 'failed', result: 'denied' }),
        ]}
      />
    );

    expect(screen.getByRole('button').className).toContain('text-error');
  });
});
