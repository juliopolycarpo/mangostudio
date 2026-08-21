import { beforeEach, describe, expect, it, jest } from 'bun:test';
import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ToolCallBlock } from '@/features/chat/components/ToolCallBlock';
import { render } from '../../support/harness/render';

function snapshot(overrides: Partial<ToolExecutionSnapshot> = {}): ToolExecutionSnapshot {
  return {
    status: 'succeeded',
    source: 'builtin',
    queuedAt: 1_000,
    startedAt: 1_001,
    finishedAt: 1_641,
    durationMs: 640,
    ...overrides,
  };
}

describe('ToolCallBlock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a pending state', () => {
    render(
      <ToolCallBlock
        name="list_directory"
        args={{ path: '/home/polycarpo/foo' }}
        status="running"
      />
    );
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent(/List/i);
    expect(button).toHaveTextContent('~/foo');
  });

  it('renders a success state', () => {
    render(
      <ToolCallBlock
        name="read_file"
        args={{ path: '/var/log/syslog' }}
        status="succeeded"
        result='{"content":"logs"}'
      />
    );
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent(/Read/i);
    expect(button).toHaveTextContent('/var/log/syslog');

    // Open the details
    fireEvent.click(button);
    expect(screen.getByText('args')).toBeInTheDocument();
    expect(screen.getByText('result')).toBeInTheDocument();
    expect(screen.getByText(/"content": "logs"/)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    render(
      <ToolCallBlock
        name="generate_image"
        args={{ prompt: 'a cat' }}
        status="failed"
        result="Failed to generate"
      />
    );
    const button = screen.getByRole('button', { name: /Generate Image.*Failed/i });
    expect(button).toHaveTextContent(/Generate Image/i);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    // Failed calls open automatically so remediation is immediately visible.
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('Failed to generate')).toBeInTheDocument();
  });

  it('opens automatically when a running call later fails', () => {
    const { rerender } = render(
      <ToolCallBlock name="write_file" args={{ path: '/a' }} status="running" />
    );
    expect(screen.queryByText('args')).not.toBeInTheDocument();

    rerender(
      <ToolCallBlock
        name="write_file"
        args={{ path: '/a' }}
        status="failed"
        result='{"error":"Re-read the file and retry."}'
      />
    );

    expect(screen.getByText('Re-read the file and retry.')).toBeInTheDocument();
  });

  it('renders a cancelled state with its status label', () => {
    render(<ToolCallBlock name="bash" args={{ command: 'sleep 60' }} status="cancelled" />);
    expect(screen.getByRole('button')).toHaveTextContent('Cancelled');
  });

  it('renders a timed_out state with error tone and status label', () => {
    render(
      <ToolCallBlock
        name="bash"
        args={{ command: 'sleep 60' }}
        status="timed_out"
        result='{"error":"Command timed out after 30 seconds."}'
        execution={snapshot({ status: 'timed_out', reasonCode: 'timeout', durationMs: 30_000 })}
      />
    );
    const button = screen.getByRole('button', { name: /Bash.*Timed out/i });
    expect(button).toHaveTextContent('Timed out');
    expect(button).toHaveTextContent('30.0s');
    expect(button.className).toContain('text-error');
  });

  it('shows duration and source badge from the execution snapshot', () => {
    render(
      <ToolCallBlock
        name="mcp__files__read_resource"
        args={{}}
        status="succeeded"
        result='"ok"'
        execution={snapshot({ source: 'mcp' })}
      />
    );
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('MCP');
    expect(button).toHaveTextContent('640ms');
  });

  it('copies the result from the expanded body', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    // jsdom left `navigator.clipboard` writable; happy-dom defines it as a
    // readonly getter, so `Object.assign` throws outright. Defined and restored
    // instead, so the substitution stays inside this test.
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(
      <ToolCallBlock name="read_file" args={{ path: '/a' }} status="succeeded" result='"logs"' />
    );

    try {
      fireEvent.click(screen.getByRole('button'));
      fireEvent.click(screen.getByTitle('Copy result'));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('logs');
      });
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });

  it('renders get_current_datetime without hint', () => {
    render(
      <ToolCallBlock name="get_current_datetime" args={{}} status="succeeded" result="2024-01-01" />
    );
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent(/Date/i);
  });

  it('renders apply_patch with its diff icon and multi-file scope', () => {
    const { container } = render(
      <ToolCallBlock
        name="apply_patch"
        args={{
          patch: `*** Begin Patch
*** Update File: /home/ada/src/app.ts
-old
+new
*** Add File: /home/ada/src/new.ts
+content
*** End Patch`,
        }}
        status="running"
      />
    );

    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('Patch');
    expect(button).toHaveTextContent('~/src/app.ts (+1 more)');
    expect(container.querySelector('.lucide-file-diff')).toBeInTheDocument();
  });

  it('toggles expansion', async () => {
    render(
      <ToolCallBlock
        name="unknown_tool"
        args={{ param: 'value' }}
        status="succeeded"
        result="done"
      />
    );
    const button = screen.getByRole('button');

    // Initially closed
    expect(screen.queryByText('args')).not.toBeInTheDocument();

    // Open
    fireEvent.click(button);
    expect(screen.getByText('args')).toBeInTheDocument();

    // Close
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.queryByText('args')).not.toBeInTheDocument();
    });
  });
});
