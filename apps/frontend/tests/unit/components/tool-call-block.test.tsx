import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ToolCallBlock } from '@/features/chat/components/ToolCallBlock';
import { stubClipboard } from '../../support/harness/clipboard';
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
    const { container } = render(
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
    // The rail node and the tool's own name carry the outcome together.
    expect(container.querySelector('.chat-timeline-item--error')).toBeInTheDocument();
    expect(screen.getByText('Bash').className).toContain('text-danger');
  });

  it('colours the tool name by outcome', () => {
    const { container } = render(
      <ToolCallBlock
        name="list_directory"
        args={{ path: '/home/polycarpo/foo' }}
        status="succeeded"
        result='{"path":"/home/polycarpo/foo","entries":[{"name":"a","type":"file"}]}'
      />
    );

    expect(screen.getByText('List').className).toContain('text-success');
    expect(container.querySelector('.chat-timeline-item--success')).toBeInTheDocument();
  });

  it('reports what a finished call produced beside its duration', () => {
    render(
      <ToolCallBlock
        name="grep"
        args={{ pattern: 'flush\\(\\)' }}
        status="succeeded"
        result='{"pattern":"flush","matches":[{"file":"a"},{"file":"b"},{"file":"c"}]}'
        execution={snapshot({ durationMs: 28 })}
      />
    );

    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('3 hits');
    expect(button).toHaveTextContent('28ms');
  });

  it('withholds the outcome while a call is still running', () => {
    render(
      <ToolCallBlock
        name="grep"
        args={{ pattern: 'x' }}
        status="running"
        result='{"matches":[{"file":"a"}]}'
        execution={snapshot({ status: 'running' })}
      />
    );

    const button = screen.getByRole('button');
    expect(button).not.toHaveTextContent('1 hit');
    expect(button).not.toHaveTextContent('640ms');
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
    stubClipboard(writeText);
    render(
      <ToolCallBlock name="read_file" args={{ path: '/a' }} status="succeeded" result='"logs"' />
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByTitle('Copy result'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('logs');
    });
  });

  describe('a shell run', () => {
    const FAILED = JSON.stringify({
      shell: 'bash',
      command: 'bun run build',
      exitCode: 2,
      signal: null,
      stdout: '',
      stderr: 'src/app.ts:3:1 - error TS2304: Cannot find name "foo".\nFound 1 error.\n',
      truncated: false,
    });

    it('reads a failure as its own lines, not as an escaped JSON string', () => {
      render(
        <ToolCallBlock
          name="bash"
          args={{ command: 'bun run build' }}
          status="failed"
          result={FAILED}
          execution={snapshot({ status: 'failed', durationMs: 5200 })}
        />
      );

      // Real line breaks and real quotes: nothing of the wire format shows.
      const body = screen.getByText(/Cannot find name/);
      expect(body.textContent).toBe(
        'src/app.ts:3:1 - error TS2304: Cannot find name "foo".\nFound 1 error.\n'
      );
      expect(body.textContent).not.toContain('\\n');
      expect(body.textContent).not.toContain('\\"');
      // The row already says `exit 2`, so the body does not repeat it.
      expect(screen.queryByText(/exitCode/)).toBeNull();
      expect(screen.getByRole('button', { name: /exit 2/ })).toBeInTheDocument();
    });

    it('draws each stream that printed something as its own section and skips the empty one', () => {
      render(<ToolCallBlock name="bash" args={{ command: 'x' }} status="failed" result={FAILED} />);
      expect(screen.getByText('stderr')).toBeInTheDocument();
      expect(screen.queryByText('stdout')).toBeNull();
      expect(screen.queryByText('error')).toBeNull();
      // The failure's text keeps the primary colour; the label carries the tone.
      expect(screen.getByText(/Cannot find name/).className).toContain('text-fg');
      expect(screen.getByText(/Cannot find name/).className).not.toContain('text-danger');
      expect(screen.getByText('stderr').className).toContain('text-danger');
    });

    it('leads with the stream the reader came for and tints only the failing one', () => {
      const result = JSON.stringify({ exitCode: 1, stdout: 'compiling\n', stderr: 'boom\n' });
      const { rerender } = render(
        <ToolCallBlock name="bash" args={{}} status="failed" result={result} />
      );
      const labels = () =>
        screen.getAllByText(/^(stdout|stderr)$/).map((label) => label.textContent);

      expect(labels()).toEqual(['stderr', 'stdout']);
      expect(screen.getByText('stdout').className).not.toContain('text-danger');

      // A failed call opens itself, and stays open when the same row settles.
      rerender(<ToolCallBlock name="bash" args={{}} status="succeeded" result={result} />);
      expect(labels()).toEqual(['stdout', 'stderr']);
      expect(screen.getByText('stderr').className).not.toContain('text-danger');
    });

    it('copies the text of the section it sits in', async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      stubClipboard(writeText);
      render(
        <ToolCallBlock
          name="bash"
          args={{}}
          status="succeeded"
          result={JSON.stringify({ exitCode: 0, stdout: 'hello\n', stderr: 'warn\n' })}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /Bash/ }));

      fireEvent.click(screen.getByTitle('Copy stderr'));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('warn\n'));
      fireEvent.click(screen.getByTitle('Copy stdout'));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello\n'));
    });

    it('says when the runtime cut the output', () => {
      render(
        <ToolCallBlock
          name="bash"
          args={{}}
          status="failed"
          result={JSON.stringify({ exitCode: 1, stdout: '', stderr: 'x', truncated: true })}
        />
      );
      expect(screen.getByText(en.tools.outputTruncated)).toBeInTheDocument();
    });

    it('keeps the payload when the run printed nothing, so the exit code is not lost', () => {
      render(
        <ToolCallBlock
          name="bash"
          args={{}}
          status="succeeded"
          result={JSON.stringify({ exitCode: 0, stdout: '', stderr: '' })}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
      expect(screen.getByText('result')).toBeInTheDocument();
      expect(screen.getByText(/"exitCode": 0/)).toBeInTheDocument();
    });

    it('still unwraps the error a timed-out run leaves behind', () => {
      render(
        <ToolCallBlock
          name="bash"
          args={{}}
          status="timed_out"
          result='{"error":"Command timed out after 30 seconds."}'
        />
      );
      expect(screen.getByText('error')).toBeInTheDocument();
      expect(screen.getByText('Command timed out after 30 seconds.')).toBeInTheDocument();
    });

    it('leaves another tool with a stdout field to the generic body', () => {
      render(
        <ToolCallBlock
          name="mcp__x__run"
          args={{}}
          status="succeeded"
          result={JSON.stringify({ stdout: 'a\nb' })}
        />
      );
      fireEvent.click(screen.getByRole('button'));
      expect(screen.queryByText('stdout')).toBeNull();
      expect(screen.getByText(/"stdout": "a\\nb"/)).toBeInTheDocument();
    });
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
