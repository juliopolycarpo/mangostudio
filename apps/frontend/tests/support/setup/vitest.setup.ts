import '@testing-library/jest-dom';

class ResizeObserverMock {
  observe() {
    // noop – mock for jsdom
  }
  unobserve() {
    // noop – mock for jsdom
  }
  disconnect() {
    // noop – mock for jsdom
  }
}

class IntersectionObserverMock {
  readonly root: Element | Document | null = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [];

  observe() {
    // noop – mock for jsdom
  }
  unobserve() {
    // noop – mock for jsdom
  }
  disconnect() {
    // noop – mock for jsdom
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

globalThis.matchMedia =
  globalThis.matchMedia ||
  (() => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => undefined as void,
    removeListener: () => undefined as void,
    addEventListener: () => undefined as void,
    removeEventListener: () => undefined as void,
    dispatchEvent: () => false,
  }));

globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver =
  IntersectionObserverMock as unknown as typeof IntersectionObserver;
