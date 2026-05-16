import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThinkingBlock } from '@/features/chat/components/ThinkingBlock';
import { render } from '../../support/harness/render';

describe('ThinkingBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders closed when not streaming', () => {
    render(<ThinkingBlock messageId="msg-1" text="Test thought" isStreaming={false} />);
    const button = screen.getByRole('button', { name: /Thought process/i });
    expect(button).toBeInTheDocument();
    expect(screen.queryByText('Test thought')).not.toBeInTheDocument();
  });

  it('renders open when streaming', () => {
    render(<ThinkingBlock messageId="msg-2" text="Streaming thought" isStreaming={true} />);
    const button = screen.getByRole('button', { name: /Thinking.../i });
    expect(button).toBeInTheDocument();
    expect(screen.getByText('Streaming thought')).toBeInTheDocument();
  });

  it('toggles expansion on click', async () => {
    render(<ThinkingBlock messageId="msg-3" text="Toggle thought" isStreaming={false} />);
    const button = screen.getByRole('button', { name: /Thought process/i });

    // Initially closed
    expect(screen.queryByText('Toggle thought')).not.toBeInTheDocument();

    // Open
    fireEvent.click(button);
    expect(screen.getByText('Toggle thought')).toBeInTheDocument();

    // Close
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.queryByText('Toggle thought')).not.toBeInTheDocument();
    });
  });

  it('handles scroll events', () => {
    render(<ThinkingBlock messageId="msg-4" text="Scroll thought" isStreaming={true} />);

    // Wait for it to open and find the scrollable container
    const scrollContainer = screen.getByText('Scroll thought').closest('.overflow-y-auto');
    expect(scrollContainer).toBeInTheDocument();

    if (scrollContainer) {
      fireEvent.scroll(scrollContainer, { target: { scrollTop: 50 } });
    }
  });
});
