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
import type { Message } from '@mangostudio/shared';
import { en } from '@mangostudio/shared/i18n';
import { act, fireEvent, render } from '../../../support/harness/render';

const { ChatFeed, ESTIMATED_ROW_HEIGHT_PX } = await import(
  '../../../../src/features/chat/components/ChatFeed'
);

type RowHeight = (index: number) => number;

interface Observation {
  readonly target: Element;
  lastSize: number | null;
}

/**
 * A browser-shaped layout for one ChatFeed scroll port.
 *
 * The port is the feed's `<section>`, its scroll height is the transcript
 * wrapper's inline height (which the virtualizer owns), and each row is as
 * tall as `rowHeight(index)` says.
 */
class FakeTranscriptLayout {
  rowHeight: RowHeight = () => ESTIMATED_ROW_HEIGHT_PX;
  /** The port's height; the window is exactly as tall, as in a full-height app. */
  viewportPx = 400;
  private scrollTopPx = 0;
  private dispatchedScrollTopPx = 0;
  private readonly observers = new Set<FakeLayoutResizeObserver>();
  private readonly originals = new Map<string, PropertyDescriptor | undefined>();
  private readonly originalResizeObserver = globalThis.ResizeObserver;
  private originalInnerHeight: PropertyDescriptor | undefined;

  install(): void {
    const layout = this;
    this.stub('offsetHeight', {
      get(this: HTMLElement) {
        return layout.heightOf(this);
      },
    });
    this.stub('clientHeight', {
      get(this: HTMLElement) {
        return layout.isPort(this) ? layout.viewportPx : layout.heightOf(this);
      },
    });
    this.stub('scrollHeight', {
      get(this: HTMLElement) {
        return layout.isPort(this) ? layout.contentHeight(this) : layout.heightOf(this);
      },
    });
    this.stub('scrollTop', {
      get(this: HTMLElement) {
        return layout.isPort(this) ? layout.readScrollTop(this) : 0;
      },
      set(this: HTMLElement, value: number) {
        if (layout.isPort(this)) layout.writeScrollTop(this, value);
      },
    });
    this.stub('scrollTo', {
      value(this: HTMLElement, options: ScrollToOptions) {
        if (typeof options.top === 'number') this.scrollTop = options.top;
      },
    });
    this.originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get: () => layout.viewportPx,
    });
    const Observer = class extends FakeLayoutResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback, layout);
      }
    };
    globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
    window.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  }

  uninstall(): void {
    for (const [name, descriptor] of this.originals) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
    globalThis.ResizeObserver = this.originalResizeObserver;
    window.ResizeObserver = this.originalResizeObserver;
    if (this.originalInnerHeight) {
      Object.defineProperty(window, 'innerHeight', this.originalInnerHeight);
    } else {
      delete (window as unknown as Record<string, unknown>).innerHeight;
    }
  }

  register(observer: FakeLayoutResizeObserver): void {
    this.observers.add(observer);
  }

  unregister(observer: FakeLayoutResizeObserver): void {
    this.observers.delete(observer);
  }

  /** The largest `scrollTop` the port can hold right now. */
  maxScrollTop(port: HTMLElement): number {
    return Math.max(0, this.contentHeight(port) - this.viewportPx);
  }

  heightOf(element: HTMLElement): number {
    if (this.isPort(element)) return this.viewportPx;
    const index = element.getAttribute('data-index');
    if (index !== null) return this.rowHeight(Number(index));
    return Number.parseFloat(element.style.height) || 0;
  }

  /**
   * Runs one rendering update the way a browser orders it: the queued `scroll`
   * event first, then ResizeObserver delivery. Each delivery pass gathers every
   * observer's changed boxes before any callback runs, calls the observers in
   * creation order, and — the depth rule — only looks at boxes deeper than the
   * shallowest one it just reported on its next pass. A shallower box that
   * changed meanwhile waits for the next frame, which is what a frame paints
   * around.
   */
  flushFrame(port: HTMLElement): void {
    act(() => {
      const top = this.readScrollTop(port);
      if (top !== this.dispatchedScrollTopPx) {
        this.dispatchedScrollTopPx = top;
        fireEvent.scroll(port);
      }
    });
    let shallowestReported = -1;
    for (let pass = 0; pass < 10; pass++) {
      const batches = [...this.observers]
        .map((observer) => ({ observer, entries: observer.gatherChanges(shallowestReported) }))
        .filter((batch) => batch.entries.length > 0);
      if (batches.length === 0) return;
      const depths = batches.flatMap((batch) =>
        batch.entries.map((entry) => depthOf(entry.target))
      );
      shallowestReported = Math.min(...depths);
      for (const batch of batches) act(() => batch.observer.deliver(batch.entries));
    }
  }

  /** Runs frames until the layout stops moving, as a few browser frames would. */
  settle(port: HTMLElement): void {
    for (let frame = 0; frame < 10; frame++) this.flushFrame(port);
  }

  private isPort(element: HTMLElement): boolean {
    return element.tagName === 'SECTION';
  }

  private contentHeight(port: HTMLElement): number {
    const content = port.querySelector<HTMLElement>(':scope > div');
    return content ? Number.parseFloat(content.style.height) || 0 : 0;
  }

  /** A browser re-clamps the position when the content under it shrinks. */
  private readScrollTop(port: HTMLElement): number {
    this.scrollTopPx = Math.min(this.scrollTopPx, this.maxScrollTop(port));
    return this.scrollTopPx;
  }

  private writeScrollTop(port: HTMLElement, value: number): void {
    this.scrollTopPx = Math.max(0, Math.min(value, this.maxScrollTop(port)));
  }

  private stub(name: string, descriptor: PropertyDescriptor): void {
    if (!this.originals.has(name)) {
      this.originals.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    }
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
  }
}

/** A ResizeObserver that reports the fake layout's sizes, initial size included. */
class FakeLayoutResizeObserver {
  private readonly observations: Observation[] = [];

  constructor(
    private readonly callback: ResizeObserverCallback,
    private readonly layout: FakeTranscriptLayout
  ) {
    layout.register(this);
  }

  observe(target: Element): void {
    if (this.observations.some((entry) => entry.target === target)) return;
    this.observations.push({ target, lastSize: null });
  }

  unobserve(target: Element): void {
    const index = this.observations.findIndex((entry) => entry.target === target);
    if (index >= 0) this.observations.splice(index, 1);
  }

  disconnect(): void {
    this.observations.length = 0;
    this.layout.unregister(this);
  }

  /** Records and returns the boxes deeper than `belowDepth` whose size changed. */
  gatherChanges(belowDepth: number): ResizeObserverEntry[] {
    const entries: ResizeObserverEntry[] = [];
    for (const observation of this.observations) {
      if (!observation.target.isConnected) continue;
      if (depthOf(observation.target) <= belowDepth) continue;
      const size = this.layout.heightOf(observation.target as HTMLElement);
      if (size === observation.lastSize) continue;
      observation.lastSize = size;
      const box = { blockSize: size, inlineSize: 800 };
      entries.push({
        target: observation.target,
        borderBoxSize: [box],
        contentBoxSize: [box],
        devicePixelContentBoxSize: [box],
        contentRect: { height: size, width: 800 } as DOMRectReadOnly,
      });
    }
    return entries;
  }

  deliver(entries: ResizeObserverEntry[]): void {
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

/** How many ancestors an element has; ResizeObserver orders its passes by it. */
function depthOf(element: Element): number {
  let depth = 0;
  for (let node = element.parentElement; node; node = node.parentElement) depth++;
  return depth;
}

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

function openFeed(chatId: string, messages: Message[]) {
  const view = render(<ChatFeed chatId={chatId} messages={messages} />);
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
