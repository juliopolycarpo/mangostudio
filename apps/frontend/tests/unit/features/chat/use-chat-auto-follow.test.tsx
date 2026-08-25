/**
 * Unit tests for useChatAutoFollow.
 * happy-dom does not lay out elements, so scroll metrics (scrollHeight, clientHeight,
 * scrollTop) are stubbed on the prototype to drive the follow logic. Each test
 * mounts a tiny harness that wires the hook to a real scroll container.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { Message } from '@mangostudio/shared';
import { fireEvent, render } from '@testing-library/react';
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

/**
 * A ResizeObserver whose notifications a test fires by hand.
 *
 * The shared setup installs a noop observer — happy-dom lays nothing out, so
 * there is no real resize to report — but growth *is* the signal this hook
 * follows, so these tests have to be able to say when the transcript grew.
 */
class FakeResizeObserver {
  static readonly instances = new Set<FakeResizeObserver>();
  private readonly notify: () => void;
  private readonly observed = new Set<Element>();

  constructor(callback: () => void) {
    this.notify = callback;
    FakeResizeObserver.instances.add(this);
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
    FakeResizeObserver.instances.delete(this);
  }

  /** Reports a size change on `target` to every observer watching it. */
  static resize(target: Element) {
    for (const instance of FakeResizeObserver.instances) {
      if (instance.observed.has(target)) instance.notify();
    }
  }
}

const realResizeObserver = globalThis.ResizeObserver;

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
  FakeResizeObserver.instances.clear();
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  for (const name of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  globalThis.ResizeObserver = realResizeObserver;
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
  const { parentRef, contentRef, showScrollButton, handleScroll, scrollToBottom } =
    useChatAutoFollow(chatId, messages);
  return (
    <div>
      <div data-testid="scroll" ref={parentRef} onScroll={handleScroll}>
        {/* Mirrors ChatFeed: the transcript wrapper only exists once there is
            something to show, so the observer attaches on the same edge. */}
        {messages.length > 0 && (
          <div data-testid="content" ref={contentRef}>
            {messages.map((m) => (
              <div key={m.id}>{m.id}</div>
            ))}
          </div>
        )}
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

  it('follows growth that moves neither the part count nor the message text', () => {
    const thinking = (text: string) =>
      makeMessage('1', { isGenerating: true, parts: [{ type: 'thinking', text }] });
    const { getByTestId, rerender } = render(<FeedHarness chatId="a" messages={[thinking('a')]} />);

    // A thinking delta rewrites the part in place, so every message-shaped
    // signal the follow effect watches is unchanged — only the row got taller.
    scrollTopValue = 0;
    scrollHeightValue = 2600;
    rerender(<FeedHarness chatId="a" messages={[thinking('a longer thought')]} />);
    expect(scrollTopValue).toBe(0);

    FakeResizeObserver.resize(getByTestId('content'));

    expect(scrollTopValue).toBe(2600);
  });

  it('leaves the reader where they are when the transcript grows after a read-back', () => {
    const { getByTestId } = render(
      <FeedHarness chatId="a" messages={[makeMessage('1', { isGenerating: true, text: 'a' })]} />
    );

    scrollTopValue = 0;
    fireEvent.scroll(getByTestId('scroll'));

    scrollHeightValue = 2600;
    FakeResizeObserver.resize(getByTestId('content'));

    expect(scrollTopValue).toBe(0);
  });

  it('keeps following when growth alone leaves the container short of its bottom', () => {
    const { getByTestId, rerender } = render(
      <FeedHarness chatId="a" messages={[makeMessage('1', { isGenerating: true, text: 'a' })]} />
    );

    // The feed's own scroll write queues a `scroll` event; by the time it lands
    // the streaming row has been measured taller, so the position it reports is
    // no longer near the bottom. That is content moving, not the reader.
    scrollHeightValue = 4000;
    fireEvent.scroll(getByTestId('scroll'));
    expect(getByTestId('show-button').textContent).toBe('false');

    scrollHeightValue = 4400;
    rerender(
      <FeedHarness chatId="a" messages={[makeMessage('1', { isGenerating: true, text: 'ab' })]} />
    );

    expect(scrollTopValue).toBe(4400);
  });

  it('re-enables follow and smooth-scrolls when the button is clicked', () => {
    const { getByTestId } = render(<FeedHarness chatId="a" messages={[makeMessage('1')]} />);
    const scroll = getByTestId('scroll');
    const scrollTo = jest.fn();
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
