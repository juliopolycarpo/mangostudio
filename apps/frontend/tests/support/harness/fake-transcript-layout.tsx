/**
 * A browser-shaped layout for a ChatFeed under happy-dom, which lays nothing out.
 *
 * Shared by the tests that drive the real virtualizer: see `FakeTranscriptLayout`.
 */

import { act, fireEvent } from './render';

const { ESTIMATED_ROW_HEIGHT_PX } = await import('../../../src/features/chat/components/ChatFeed');

export type RowHeight = (index: number) => number;

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
export class FakeTranscriptLayout {
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
    // The transcript wrapper is the child that carries an inline height; the
    // loading indicator before it is a zero-height overlay with none.
    const content = port.querySelector<HTMLElement>(':scope > div[style]');
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
