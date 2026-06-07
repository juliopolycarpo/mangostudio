/**
 * Unit tests for useChatAutoFollow.
 * jsdom does not lay out elements, so scroll metrics (scrollHeight, clientHeight,
 * scrollTop) are stubbed on the prototype to drive the follow logic. Each test
 * mounts a tiny harness that wires the hook to a real scroll container.
 */

import type { Message } from '@mangostudio/shared';
import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isNearBottom,
  useChatAutoFollow,
} from '../../../../src/features/chat/hooks/use-chat-auto-follow';

let scrollHeightValue = 1000;
let clientHeightValue = 400;
let scrollTopValue = 0;

function stubMetric(name: 'scrollHeight' | 'clientHeight', read: () => number) {
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: read });
}

beforeEach(() => {
  scrollHeightValue = 1000;
  clientHeightValue = 400;
  scrollTopValue = 0;
  stubMetric('scrollHeight', () => scrollHeightValue);
  stubMetric('clientHeight', () => clientHeightValue);
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get: () => scrollTopValue,
    set: (value: number) => {
      scrollTopValue = value;
    },
  });
});

afterEach(() => {
  for (const name of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

function makeMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    chatId: 'chat-1',
    role: 'ai',
    text: '',
    timestamp: 0,
    ...overrides,
  };
}

function FeedHarness({ chatId, messages }: { chatId: string | null; messages: Message[] }) {
  const { parentRef, showScrollButton, handleScroll, scrollToBottom } = useChatAutoFollow(
    chatId,
    messages
  );
  return (
    <div>
      <div data-testid="scroll" ref={parentRef} onScroll={handleScroll}>
        {messages.map((m) => (
          <div key={m.id}>{m.id}</div>
        ))}
      </div>
      <span data-testid="show-button">{String(showScrollButton)}</span>
      <button type="button" data-testid="to-bottom" onClick={scrollToBottom}>
        bottom
      </button>
    </div>
  );
}

describe('isNearBottom', () => {
  it('is true within the threshold and false beyond it', () => {
    const make = (scrollHeight: number, scrollTop: number, clientHeight: number) =>
      ({ scrollHeight, scrollTop, clientHeight }) as HTMLElement;

    expect(isNearBottom(make(1000, 580, 400))).toBe(true); // gap 20 <= 24
    expect(isNearBottom(make(1000, 600, 400))).toBe(true); // gap 0
    expect(isNearBottom(make(1000, 0, 400))).toBe(false); // gap 600
  });
});

describe('useChatAutoFollow', () => {
  it('scrolls to the bottom on initial mount', () => {
    scrollHeightValue = 1500;
    render(<FeedHarness chatId="a" messages={[makeMessage('1')]} />);

    expect(scrollTopValue).toBe(1500);
  });

  it('does not scroll on mount when there are no messages', () => {
    render(<FeedHarness chatId="a" messages={[]} />);

    expect(scrollTopValue).toBe(0);
  });

  it('re-scrolls to bottom after switching chats and loading new messages', () => {
    const { rerender } = render(<FeedHarness chatId="a" messages={[makeMessage('1')]} />);

    // User reads back, then switches chats. The query briefly resets to empty
    // before the next chat's messages arrive.
    scrollTopValue = 0;
    scrollHeightValue = 2200;
    rerender(<FeedHarness chatId="b" messages={[]} />);
    rerender(<FeedHarness chatId="b" messages={[makeMessage('x'), makeMessage('y')]} />);

    expect(scrollTopValue).toBe(2200);
  });

  it('follows the bottom while the latest message streams', () => {
    const { rerender } = render(
      <FeedHarness chatId="a" messages={[makeMessage('1', { isGenerating: true, text: 'a' })]} />
    );

    scrollTopValue = 0;
    scrollHeightValue = 900;
    rerender(
      <FeedHarness chatId="a" messages={[makeMessage('1', { isGenerating: true, text: 'ab' })]} />
    );

    expect(scrollTopValue).toBe(900);
  });

  it('stops following once the user scrolls away from the bottom', () => {
    const { getByTestId, rerender } = render(
      <FeedHarness chatId="a" messages={[makeMessage('1', { isGenerating: true, text: 'a' })]} />
    );

    // Simulate scrolling up: far from the bottom.
    scrollTopValue = 0;
    scrollHeightValue = 1000;
    clientHeightValue = 400;
    fireEvent.scroll(getByTestId('scroll'));
    expect(getByTestId('show-button').textContent).toBe('true');

    // Further streaming must not yank the view back down.
    scrollHeightValue = 3000;
    rerender(
      <FeedHarness chatId="a" messages={[makeMessage('1', { isGenerating: true, text: 'abc' })]} />
    );

    expect(scrollTopValue).toBe(0);
  });

  it('toggles the scroll button based on proximity to the bottom', () => {
    const { getByTestId } = render(<FeedHarness chatId="a" messages={[makeMessage('1')]} />);
    const scroll = getByTestId('scroll');

    scrollTopValue = 0; // gap 600 → far from bottom
    fireEvent.scroll(scroll);
    expect(getByTestId('show-button').textContent).toBe('true');

    scrollTopValue = 600; // gap 0 → at the bottom
    fireEvent.scroll(scroll);
    expect(getByTestId('show-button').textContent).toBe('false');
  });

  it('re-enables follow and smooth-scrolls when the button is clicked', () => {
    const { getByTestId } = render(<FeedHarness chatId="a" messages={[makeMessage('1')]} />);
    const scroll = getByTestId('scroll');
    const scrollTo = vi.fn();
    (scroll as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;

    // Scroll away so the button shows.
    scrollTopValue = 0;
    fireEvent.scroll(scroll);
    expect(getByTestId('show-button').textContent).toBe('true');

    fireEvent.click(getByTestId('to-bottom'));

    expect(getByTestId('show-button').textContent).toBe('false');
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
  });
});
