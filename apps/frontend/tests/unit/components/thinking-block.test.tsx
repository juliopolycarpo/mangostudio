import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { fireEvent, screen } from '@testing-library/react';
import { ThinkingBlock } from '@/features/chat/components/ThinkingBlock';
import { flushAsyncRender, render } from '../../support/harness/render';

describe('ThinkingBlock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders closed when not streaming', async () => {
    render(<ThinkingBlock messageId="msg-1" text="Test thought" isStreaming={false} />);
    await flushAsyncRender();
    const button = screen.getByRole('button', { name: /Thought/i });
    expect(button).toBeInTheDocument();
    expect(screen.queryByText('Test thought')).not.toBeInTheDocument();
  });

  it('renders open when streaming', async () => {
    render(<ThinkingBlock messageId="msg-2" text="Streaming thought" isStreaming={true} />);
    await flushAsyncRender();
    const button = screen.getByRole('button', { name: /Thinking.../i });
    expect(button).toBeInTheDocument();
    expect(screen.getByText('Streaming thought')).toBeInTheDocument();
  });

  // A thinking part carries no timestamps, so the elapsed time is measured in
  // the component across the streaming lifecycle. A block that never streamed
  // here — a reloaded transcript — has no duration to name and must not invent
  // one.
  it('names the elapsed time only for a thought it watched finish', async () => {
    // Offset the real clock rather than freezing it: `motion` drives its exit
    // animations off `performance.now()` too, and a constant there stalls the
    // frame loop for the rest of the file.
    const realNow = performance.now.bind(performance);
    let offsetMs = 0;
    const nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => realNow() + offsetMs);

    // Stamp before mount so the stop-path offset can target 2s from this
    // origin, not from "now plus a constant". A fixed +2400ms jump only had
    // a 100ms budget before `Math.round(ms / 1000)` became 3s; the first
    // flush (lazy markdown on a loaded event loop) regularly spent more than
    // that in CI.
    const originMs = realNow();
    const { rerender } = render(
      <ThinkingBlock messageId="msg-timed" text="Timed thought" isStreaming={true} />
    );
    await flushAsyncRender();

    offsetMs = originMs + 2_000 - realNow();
    rerender(<ThinkingBlock messageId="msg-timed" text="Timed thought" isStreaming={false} />);
    await flushAsyncRender();
    nowSpy.mockRestore();

    expect(screen.getByRole('button', { name: /Thought for 2s/i })).toBeInTheDocument();
  });

  it('says only "Thought" for a block restored without a measurement', async () => {
    render(<ThinkingBlock messageId="msg-restored" text="Restored" isStreaming={false} />);
    await flushAsyncRender();

    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('Thought');
    expect(button).not.toHaveTextContent(/Thought for/i);
  });

  it('toggles expansion on click', async () => {
    render(<ThinkingBlock messageId="msg-3" text="Toggle thought" isStreaming={false} />);
    await flushAsyncRender();
    const button = screen.getByRole('button', { name: /Thought/i });

    // Initially closed
    expect(screen.queryByText('Toggle thought')).not.toBeInTheDocument();

    // Open
    fireEvent.click(button);
    expect(screen.getByText('Toggle thought')).toBeInTheDocument();

    // Close
    fireEvent.click(button);
    expect(screen.queryByText('Toggle thought')).not.toBeInTheDocument();
  });

  // Regression: collapsing must unmount the body on the same tick. With real
  // `motion` exit animations this assertion raced the transition and the node
  // stayed mounted mid-animation, so it only failed under CI load (green on the
  // PR branch, red after merge into main). The synchronous assertion fails fast
  // wherever the deterministic-unmount contract is broken — no waitFor timeout.
  it('removes the thought body synchronously on collapse', async () => {
    render(<ThinkingBlock messageId="msg-collapse" text="Race thought" isStreaming={false} />);
    await flushAsyncRender();
    const button = screen.getByRole('button', { name: /Thought/i });

    fireEvent.click(button);
    expect(screen.getByText('Race thought')).toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.queryByText('Race thought')).not.toBeInTheDocument();
  });

  it('handles scroll events', async () => {
    render(<ThinkingBlock messageId="msg-4" text="Scroll thought" isStreaming={true} />);
    await flushAsyncRender();

    // Wait for it to open and find the scrollable container
    const scrollContainer = screen.getByText('Scroll thought').closest('.overflow-y-auto');
    expect(scrollContainer).toBeInTheDocument();

    if (scrollContainer) {
      fireEvent.scroll(scrollContainer, { target: { scrollTop: 50 } });
    }
  });
});
