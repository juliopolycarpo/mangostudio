/**
 * ChatFeed with the real virtualizer: a transcript opens on its newest rows.
 *
 * happy-dom lays nothing out, so `FakeTranscriptLayout` stands in for the
 * browser's layout engine. It is deliberately as strict as the real one where
 * the feed depends on it: `scrollTop` clamps to the scrollable range, every
 * change of the clamped position queues a `scroll` event, and a frame
 * dispatches that event before it delivers ResizeObserver notifications for
 * boxes whose size actually changed, in creation order and under the depth
 * rule — the order a browser runs them in.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Message } from '@mangostudio/shared/chat';
import { en } from '@mangostudio/shared/i18n';
import type { OlderMessages } from '../../../../src/features/chat/hooks/use-chat-page-state';
import { FakeTranscriptLayout } from '../../../support/harness/fake-transcript-layout';
import { fireEvent, render } from '../../../support/harness/render';

const { ChatFeed, ESTIMATED_ROW_HEIGHT_PX } = await import(
  '../../../../src/features/chat/components/ChatFeed'
);

/** Collects the index of every transcript row the feed ever mounts. */
class MountedRowRecorder {
  readonly indexes = new Set<number>();
  private readonly observer = new MutationObserver((records) => this.collect(records));

  start(root: Node): void {
    this.observer.observe(root, { childList: true, subtree: true });
  }

  stop(): void {
    this.collect(this.observer.takeRecords());
    this.observer.disconnect();
  }

  private collect(records: MutationRecord[]): void {
    for (const record of records) {
      for (const node of record.addedNodes) this.collectFrom(node);
    }
  }

  private collectFrom(node: Node): void {
    if (!(node instanceof HTMLElement)) return;
    const rows = [node, ...node.querySelectorAll<HTMLElement>('[data-index]')];
    for (const row of rows) {
      const index = row.getAttribute('data-index');
      if (index !== null) this.indexes.add(Number(index));
    }
  }
}

function makeMessages(chatId: string, count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${chatId}-m${index}`,
    chatId,
    role: 'user',
    text: `Note ${index}`,
    timestamp: index,
  }));
}

/** Indexes of the rows in the DOM now, with the offset each is drawn at. */
function renderedRows(port: HTMLElement): Array<{ index: number; start: number }> {
  return [...port.querySelectorAll<HTMLElement>('[data-index]')].map((row) => ({
    index: Number(row.getAttribute('data-index')),
    start: Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1] ?? Number.NaN),
  }));
}

/** Describes where the port sits, so a failure names the gap rather than two numbers. */
function positionOf(layout: FakeTranscriptLayout, port: HTMLElement): string {
  const gap = layout.maxScrollTop(port) - port.scrollTop;
  return gap === 0 ? 'at the bottom' : `${gap}px above the bottom`;
}

/** True when the rendered rows cover the whole viewport at the current position. */
function viewportIsCovered(layout: FakeTranscriptLayout, port: HTMLElement): string {
  const rows = renderedRows(port);
  const top = Math.min(...rows.map((row) => row.start));
  const bottom = Math.max(...rows.map((row) => row.start + layout.rowHeight(row.index)));
  const visibleTop = port.scrollTop;
  const visibleBottom = visibleTop + layout.viewportPx;
  if (top <= visibleTop && bottom >= visibleBottom) return 'covered';
  return `rows span ${top}-${bottom}px, viewport ${visibleTop}-${visibleBottom}px`;
}

let layout: FakeTranscriptLayout;
let recorder: MountedRowRecorder;

beforeEach(() => {
  layout = new FakeTranscriptLayout();
  layout.install();
  recorder = new MountedRowRecorder();
  recorder.start(document.body);
});

afterEach(() => {
  recorder.stop();
  layout.uninstall();
});

function openFeed(chatId: string, messages: Message[], older?: OlderMessages) {
  const view = render(<ChatFeed chatId={chatId} messages={messages} older={older} />);
  const port = view.container.querySelector('section');
  if (!port) {
    throw new Error('expected ChatFeed to render its <section> scroll port | received none');
  }
  return { ...view, port };
}

describe('ChatFeed opening position', () => {
  it('mounts only the newest rows when a long chat opens', () => {
    const { port } = openFeed('a', makeMessages('a', 60));
    layout.settle(port);
    recorder.stop();

    // The recorder must have seen rows at all, or an empty set would pass.
    expect(recorder.indexes.size).toBeGreaterThan(0);
    const lowest = Math.min(...recorder.indexes);
    // Rows 0..7 are the top of the transcript: laying them out on open is the
    // wasted work, since the feed never shows them before jumping to the end.
    const mounted = lowest >= 40 ? 'only rows near the bottom' : `row ${lowest} from the top`;
    expect(mounted).toBe('only rows near the bottom');
    expect(positionOf(layout, port)).toBe('at the bottom');
    expect(renderedRows(port).some((row) => row.index === 59)).toBe(true);
  });

  it('fills the viewport at the bottom when rows measure shorter than the estimate', () => {
    layout.rowHeight = () => 40;
    const { port } = openFeed('a', makeMessages('a', 60));
    layout.settle(port);

    expect(positionOf(layout, port)).toBe('at the bottom');
    expect(viewportIsCovered(layout, port)).toBe('covered');
  });

  // The virtualizer starts from the port's real position, read once the
  // opening jump has run, not from an estimated end offset. An estimated start
  // would wait on a `scroll` event to correct it, and a chat whose estimate
  // fits the port never moves `scrollTop`, so no such event ever comes.
  it('shows every row of a short chat that fits a tall window', () => {
    layout.viewportPx = 1200;
    const { port } = openFeed('a', makeMessages('a', 7));
    layout.settle(port);

    const indexes = renderedRows(port).map((row) => row.index);
    expect(`rows rendered: ${indexes.join(',')}`).toBe('rows rendered: 0,1,2,3,4,5,6');
    expect(positionOf(layout, port)).toBe('at the bottom');
  });

  it('shows every row when rows measure short enough for the whole chat to fit', () => {
    layout.viewportPx = 1200;
    layout.rowHeight = () => 40;
    const { port } = openFeed('a', makeMessages('a', 12));
    layout.settle(port);

    const indexes = renderedRows(port).map((row) => row.index);
    expect(`rows rendered: ${indexes.join(',')}`).toBe(
      `rows rendered: ${Array.from({ length: 12 }, (_, index) => index).join(',')}`
    );
    expect(positionOf(layout, port)).toBe('at the bottom');
  });

  it('stays at the bottom when the newest rows grow after they first render', () => {
    const { port } = openFeed('a', makeMessages('a', 60));
    layout.settle(port);

    // A lazily loaded renderer (the markdown chunk) re-lays the bottom rows out
    // taller a moment after the transcript first painted. Every frame after
    // that is one the reader sees, so each has to be at the bottom — not just
    // the one the layout eventually settles on.
    layout.rowHeight = (index) => (index >= 55 ? 320 : ESTIMATED_ROW_HEIGHT_PX);
    const frames: string[] = [];
    for (let frame = 0; frame < 5; frame++) {
      layout.flushFrame(port);
      frames.push(positionOf(layout, port));
    }

    expect(frames).toEqual(Array.from({ length: 5 }, () => 'at the bottom'));
    expect(viewportIsCovered(layout, port)).toBe('covered');
  });
});

describe('ChatFeed follow after opening', () => {
  /** Sixty settled notes followed by an answer that is still streaming. */
  const streaming = (text: string): Message[] => [
    ...makeMessages('a', 60),
    { id: 'a-live', chatId: 'a', role: 'ai', text, timestamp: 60, isGenerating: true },
  ];

  it('keeps the bottom in view while the latest message streams', () => {
    const { port, rerender } = openFeed('a', streaming('Hel'));
    layout.settle(port);

    layout.rowHeight = (index) => (index === 60 ? 900 : ESTIMATED_ROW_HEIGHT_PX);
    rerender(<ChatFeed chatId="a" messages={streaming('Hello, a much longer answer')} />);
    layout.settle(port);

    expect(positionOf(layout, port)).toBe('at the bottom');
  });

  it('stops following once the reader scrolls up', () => {
    const { port, rerender, queryByTitle } = openFeed('a', streaming('Hel'));
    layout.settle(port);

    fireEvent.wheel(port);
    port.scrollTop = 1000;
    layout.flushFrame(port);

    layout.rowHeight = (index) => (index === 60 ? 900 : ESTIMATED_ROW_HEIGHT_PX);
    rerender(<ChatFeed chatId="a" messages={streaming('Hello, a much longer answer')} />);
    layout.settle(port);

    expect(`reader at ${port.scrollTop}px`).toBe('reader at 1000px');
    expect(queryByTitle(en.chat.scrollToBottom)).not.toBeNull();
  });

  it('leaves a reader who scrolled up in place when a message is appended', () => {
    const { port, rerender } = openFeed('a', makeMessages('a', 60));
    layout.settle(port);
    fireEvent.wheel(port);
    port.scrollTop = 1000;
    layout.flushFrame(port);

    rerender(<ChatFeed chatId="a" messages={makeMessages('a', 61)} />);
    layout.settle(port);

    expect(`reader at ${port.scrollTop}px`).toBe('reader at 1000px');
  });

  it('lands at the bottom of the next chat when the feed stays mounted across a switch', () => {
    const { port, rerender } = openFeed('a', makeMessages('a', 60));
    layout.settle(port);
    fireEvent.wheel(port);
    port.scrollTop = 1000;
    layout.flushFrame(port);

    // A cached chat answers at once, so the feed is not remounted in between.
    rerender(<ChatFeed chatId="b" messages={makeMessages('b', 45)} />);
    layout.settle(port);

    expect(positionOf(layout, port)).toBe('at the bottom');
    expect(renderedRows(port).some((row) => row.index === 44)).toBe(true);
  });
});

/** A named stand-in for the transcript's older-page handle: it only counts asks. */
function fakeOlder(overrides: Partial<OlderMessages> = {}) {
  const asks = { count: 0 };
  const older: OlderMessages = {
    hasMore: true,
    isLoading: false,
    failed: false,
    load: () => {
      asks.count++;
    },
    ...overrides,
  };
  return { older, asks };
}

/** Where the row showing `text` sits relative to the top of the view, or `missing`. */
function offsetInView(port: HTMLElement, text: string): number | 'missing' {
  const row = [...port.querySelectorAll<HTMLElement>('[data-index]')].find((element) =>
    element.textContent?.includes(text)
  );
  if (!row) return 'missing';
  const start = Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1] ?? Number.NaN);
  return start - port.scrollTop;
}

function olderMessages(chatId: string, count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${chatId}-older${index}`,
    chatId,
    role: 'user',
    text: `Older ${index}`,
    timestamp: index - count,
  }));
}

describe('ChatFeed loading older messages', () => {
  it('does not ask for older messages while the reader is at the bottom', () => {
    const { older, asks } = fakeOlder();
    const { port } = openFeed('a', makeMessages('a', 60), older);
    layout.settle(port);

    expect(`older asks at the bottom: ${asks.count}`).toBe('older asks at the bottom: 0');
  });

  it('asks once the reader scrolls near the top', () => {
    const { older, asks } = fakeOlder();
    const { port } = openFeed('a', makeMessages('a', 60), older);
    layout.settle(port);

    fireEvent.wheel(port);
    port.scrollTop = 0;
    layout.flushFrame(port);

    expect(asks.count).toBeGreaterThan(0);
  });

  it('does not ask when there is nothing older to load', () => {
    const { older, asks } = fakeOlder({ hasMore: false });
    const { port } = openFeed('a', makeMessages('a', 60), older);
    layout.settle(port);

    fireEvent.wheel(port);
    port.scrollTop = 0;
    layout.flushFrame(port);

    expect(`older asks with nothing older: ${asks.count}`).toBe('older asks with nothing older: 0');
  });

  it('asks on open when the chat is too short to scroll, so the viewport fills', () => {
    layout.viewportPx = 1200;
    const { older, asks } = fakeOlder();
    const { port } = openFeed('a', makeMessages('a', 4), older);
    layout.settle(port);

    expect(asks.count).toBeGreaterThan(0);
  });

  it('does not retry a failed page on its own', () => {
    layout.viewportPx = 1200;
    const { older, asks } = fakeOlder({ failed: true });
    const { port } = openFeed('a', makeMessages('a', 4), older);
    layout.settle(port);

    expect(`older asks after a failure: ${asks.count}`).toBe('older asks after a failure: 0');
  });

  it('retries a failed page when the reader scrolls near the top again', () => {
    const { older, asks } = fakeOlder({ failed: true });
    const { port } = openFeed('a', makeMessages('a', 60), older);
    layout.settle(port);

    fireEvent.wheel(port);
    port.scrollTop = 0;
    layout.flushFrame(port);

    expect(asks.count).toBeGreaterThan(0);
  });

  // At the top of the port nothing can scroll, so a reader pushing further up
  // sends no scroll event: the gesture itself has to ask again.
  it('retries a failed page when the reader pushes up while already at the top', () => {
    const { older, asks } = fakeOlder({ failed: true });
    const { port } = openFeed('a', makeMessages('a', 60), older);
    layout.settle(port);
    fireEvent.wheel(port);
    port.scrollTop = 0;
    layout.flushFrame(port);
    asks.count = 0;

    fireEvent.wheel(port, { deltaY: -120 });

    expect(`older asks after a wheel at the top: ${asks.count}`).toBe(
      'older asks after a wheel at the top: 1'
    );
  });

  it('does not ask when the reader wheels down near the top', () => {
    const { older, asks } = fakeOlder({ failed: true });
    const { port } = openFeed('a', makeMessages('a', 60), older);
    layout.settle(port);
    fireEvent.wheel(port);
    port.scrollTop = 0;
    layout.flushFrame(port);
    asks.count = 0;

    fireEvent.wheel(port, { deltaY: 120 });

    expect(`older asks after a wheel down: ${asks.count}`).toBe('older asks after a wheel down: 0');
  });

  it('says that earlier messages are loading, without moving any message', () => {
    const { older } = fakeOlder();
    const { port, rerender, queryByText } = openFeed('a', makeMessages('a', 60), older);
    layout.settle(port);
    const before = offsetInView(port, 'Note 58');
    expect(queryByText(en.chat.feed.loadingOlder)).toBeNull();

    rerender(
      <ChatFeed chatId="a" messages={makeMessages('a', 60)} older={{ ...older, isLoading: true }} />
    );
    layout.settle(port);

    expect(queryByText(en.chat.feed.loadingOlder)).not.toBeNull();
    expect(`Note 58 at ${offsetInView(port, 'Note 58')}`).toBe(`Note 58 at ${before}`);
  });

  it('keeps the reader on the same message when an older page is prepended', () => {
    const { older } = fakeOlder();
    const { port, rerender } = openFeed('a', makeMessages('a', 60), older);
    layout.settle(port);
    fireEvent.wheel(port);
    port.scrollTop = 1200;
    layout.flushFrame(port);
    layout.settle(port);
    const before = offsetInView(port, 'Note 8');
    rerender(
      <ChatFeed
        chatId="a"
        messages={[...olderMessages('a', 50), ...makeMessages('a', 60)]}
        older={older}
      />
    );
    layout.settle(port);

    expect(`Note 8 at ${offsetInView(port, 'Note 8')}`).toBe(`Note 8 at ${before}`);
  });
});
