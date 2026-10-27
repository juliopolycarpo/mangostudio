import { beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';

import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';
import { fireEvent, screen, within } from '@testing-library/react';

import type { ToolCallEntry } from '@/features/chat/components/tool-call-grouping';
import { ToolCallGroupBlock } from '@/features/chat/components/ToolCallGroupBlock';

import { render } from '../../support/harness/render';

function executionSnapshot(durationMs: number): ToolExecutionSnapshot {
  return {
    status: 'succeeded',
    source: 'builtin',
    queuedAt: 1_000,
    startedAt: 1_001,
    finishedAt: 1_001 + durationMs,
    durationMs,
  };
}

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
    jest.clearAllMocks();
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

  it('keeps the label of a clean run neutral', () => {
    const { container } = render(
      <ToolCallGroupBlock calls={[entry({ toolCallId: 't1' }), entry({ toolCallId: 't2' })]} />
    );

    const label = screen.getAllByText('Read')[0];
    expect(label.className).toContain('text-fg');
    expect(label.className).not.toContain('text-success');
    expect(container.querySelector('.chat-timeline-item--success')).toBeInTheDocument();
  });

  it('shows an error tone when any call failed', () => {
    const { container } = render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1' }),
          entry({ toolCallId: 't2', isError: false, status: 'failed', result: 'denied' }),
        ]}
      />
    );

    // A collapsed run must never hide a failure behind its neighbours.
    expect(container.querySelector('.chat-timeline-item--error')).toBeInTheDocument();
    expect(screen.getAllByText('Read')[0].className).toContain('text-danger');
  });

  it('totals the run beside the summary row', () => {
    render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1', execution: executionSnapshot(47) }),
          entry({ toolCallId: 't2', execution: executionSnapshot(51) }),
        ]}
      />
    );

    const summary = screen.getByRole('button', { name: /\+1 more/i });
    expect(summary).toHaveTextContent('2 files');
    expect(summary).toHaveTextContent('98ms');
  });

  it('sums the units a search run actually returned', () => {
    render(
      <ToolCallGroupBlock
        calls={[
          entry({
            toolCallId: 't1',
            name: 'grep',
            args: { pattern: 'a' },
            result: '{"matches":[{"file":"a"},{"file":"b"}]}',
          }),
          entry({
            toolCallId: 't2',
            name: 'grep',
            args: { pattern: 'b' },
            result: '{"matches":[{"file":"c"}]}',
          }),
        ]}
      />
    );

    expect(screen.getByRole('button', { name: /\+1 more/i })).toHaveTextContent('3 hits');
  });

  it('updates a search summary when the result changes without changing length', () => {
    const previous = '{"matches":[{},{}]}';
    const next = '{"matches":[{}]}'.padEnd(previous.length);
    expect(next).toHaveLength(previous.length);
    const second = entry({ toolCallId: 't2', name: 'grep', result: '{"matches":[{}]}' });
    const { rerender } = render(
      <ToolCallGroupBlock calls={[entry({ name: 'grep', result: previous }), second]} />
    );

    expect(screen.getByRole('button', { name: /\+1 more/i })).toHaveTextContent('3 hits');
    const updated = [entry({ name: 'grep', result: next }), { ...second }];
    rerender(<ToolCallGroupBlock calls={updated} />);
    expect(screen.getByRole('button', { name: /\+1 more/i })).toHaveTextContent('2 hits');
    updated[0].result = previous;
    rerender(<ToolCallGroupBlock calls={updated} />);
    expect(screen.getByRole('button', { name: /\+1 more/i })).toHaveTextContent('3 hits');
  });

  it('does not reparse unchanged results when the calls array is rebuilt', () => {
    const first = '{"matches":[{"file":"first"}]}';
    const second = '{"matches":[{"file":"second"}]}';
    const calls = [
      entry({ toolCallId: 't1', name: 'grep', result: first }),
      entry({ toolCallId: 't2', name: 'grep', result: second }),
    ];
    const parse = spyOn(JSON, 'parse');
    try {
      const { rerender } = render(<ToolCallGroupBlock calls={calls} />);
      expect(screen.getByRole('button', { name: /\+1 more/i })).toHaveTextContent('2 hits');
      const parses = () =>
        parse.mock.calls.filter(([value]) => value === first || value === second);
      expect(parses()).toHaveLength(2);
      rerender(<ToolCallGroupBlock calls={calls.map((call) => ({ ...call }))} />);
      expect(parses()).toHaveLength(2);
    } finally {
      parse.mockRestore();
    }
  });

  it('opens failed calls and presents their remediation without a JSON wrapper', () => {
    const remediation = 'Re-read the file and retry with the current content.';
    render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1' }),
          entry({
            toolCallId: 't2',
            status: 'failed',
            result: JSON.stringify({ error: remediation }),
          }),
        ]}
      />
    );

    expect(screen.getByText(remediation)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+1 more/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.queryByText(`{"error":"${remediation}"}`)).not.toBeInTheDocument();
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

    const label = screen.getAllByText('Read')[0];
    expect(label.className).toContain('text-fg-muted');
    expect(label.className).not.toContain('text-success');
    expect(container.querySelector('.chat-timeline-item--muted')).toBeInTheDocument();
    expect(container.querySelector('.lucide-ban')).toBeInTheDocument();
    expect(container.querySelector('.lucide-check')).not.toBeInTheDocument();
  });

  it('shows an error tone when any call timed out', () => {
    const { container } = render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1' }),
          entry({ toolCallId: 't2', status: 'timed_out', isError: false }),
        ]}
      />
    );

    expect(container.querySelector('.chat-timeline-item--error')).toBeInTheDocument();
  });

  it('shows a pending tone when any call awaits user input', () => {
    const { container } = render(
      <ToolCallGroupBlock
        calls={[
          entry({ toolCallId: 't1' }),
          entry({ toolCallId: 't2', status: 'awaiting_user', isPending: false }),
        ]}
      />
    );

    expect(screen.getAllByText('Read')[0].className).toContain('text-accent-fg');
    expect(container.querySelector('.chat-timeline-item--active')).toBeInTheDocument();
  });
});
