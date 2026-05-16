import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolCallBlock } from '@/features/chat/components/ToolCallBlock';
import { render } from '../../support/harness/render';

describe('ToolCallBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a pending state', () => {
    render(
      <ToolCallBlock
        name="list_directory"
        args={{ path: '/home/polycarpo/foo' }}
        isPending={true}
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
        isPending={false}
        isError={false}
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
        isPending={false}
        isError={true}
        result="Failed to generate"
      />
    );
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent(/Generate Image/i);

    // Open the details
    fireEvent.click(button);
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('Failed to generate')).toBeInTheDocument();
  });

  it('renders get_current_datetime without hint', () => {
    render(
      <ToolCallBlock
        name="get_current_datetime"
        args={{}}
        isPending={false}
        isError={false}
        result="2024-01-01"
      />
    );
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent(/Date/i);
  });

  it('toggles expansion', async () => {
    render(
      <ToolCallBlock
        name="unknown_tool"
        args={{ param: 'value' }}
        isPending={false}
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
