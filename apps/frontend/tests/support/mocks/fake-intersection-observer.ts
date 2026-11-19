/**
 * An `IntersectionObserver` a test drives by hand.
 *
 * happy-dom does no layout, so nothing ever intersects on its own. The preload
 * installs a silent stand-in; this one records what is watched and reports
 * exactly the visibility a test names, the way a scrolled list would.
 *
 * @example
 * const fake = installFakeIntersectionObserver();
 * render(<Sidebar ... />);
 * fake.setInView(['chat-1', 'chat-2']);
 */

export interface FakeIntersectionObserverHandle {
  /** Ids (via `attribute`) of the elements currently observed, across observers. */
  observedIds: (attribute: string) => string[];
  /** Makes exactly these ids intersecting and reports every observed element. */
  setInView: (ids: readonly string[], attribute?: string) => void;
  /** Observers created and not yet disconnected. */
  liveObserverCount: () => number;
  /** Puts back the observer that was installed before. */
  restore: () => void;
}

const DEFAULT_ATTRIBUTE = 'data-row-in-view-id';

export function installFakeIntersectionObserver(): FakeIntersectionObserverHandle {
  const previous = globalThis.IntersectionObserver;
  const live = new Set<FakeObserver>();

  class FakeObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly thresholds: readonly number[] = [];
    readonly observed = new Set<Element>();

    constructor(
      private readonly callback: IntersectionObserverCallback,
      init?: IntersectionObserverInit
    ) {
      this.root = init?.root ?? null;
      this.rootMargin = init?.rootMargin ?? '';
      live.add(this);
    }

    observe(element: Element) {
      this.observed.add(element);
    }
    unobserve(element: Element) {
      this.observed.delete(element);
    }
    disconnect() {
      this.observed.clear();
      live.delete(this);
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }

    report(inView: ReadonlySet<string>, attribute: string) {
      const entries = [...this.observed].map(
        (target) =>
          ({
            target,
            isIntersecting: inView.has(target.getAttribute(attribute) ?? ''),
          }) as IntersectionObserverEntry
      );
      if (entries.length > 0) this.callback(entries, this as unknown as IntersectionObserver);
    }
  }

  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;

  return {
    observedIds: (attribute) =>
      [...live].flatMap((observer) =>
        [...observer.observed].map((element) => element.getAttribute(attribute) ?? '')
      ),
    setInView: (ids, attribute = DEFAULT_ATTRIBUTE) => {
      const inView = new Set(ids);
      for (const observer of live) observer.report(inView, attribute);
    },
    liveObserverCount: () => live.size,
    restore: () => {
      globalThis.IntersectionObserver = previous;
    },
  };
}
