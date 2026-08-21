/**
 * The `bun test` counterpart to `vitest.setup.ts`: jest-dom matchers, the mock
 * factory the fetch scenario needs, DOM observer stubs, and per-test cleanup.
 *
 * Loaded as the second `[test] preload` entry, after `dom-setup.ts` has put
 * `document` on `globalThis`. Everything that touches the DOM belongs here,
 * not there.
 *
 * The global `@/lib/auth-client` stub that `vitest.setup.ts` installs with
 * `vi.mock` is not here either: it is a `tsconfig.test.json` `paths` entry
 * pointing at `auth-client-stub.ts`, so it stays resolver-level instead of
 * mutating a module graph that `bun test` shares across files.
 */

import { afterEach, expect, jest } from 'bun:test';
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { type FetchScenarioMockFactory, setFetchMockFactory } from '../mocks/create-fetch-scenario';
import { resetTestSession } from './auth-client-stub';

expect.extend(matchers);

// `jest.fn` is generic over the implementation it wraps, so it satisfies the
// factory structurally but not nominally. The declared surface in
// `create-fetch-scenario.ts` is what both lanes are held to.
setFetchMockFactory(jest.fn as unknown as FetchScenarioMockFactory);

/**
 * The frontend suite never talks to a real server, so `fetch` starts out unable
 * to.
 *
 * happy-dom is registered at `http://localhost:3001/`, which is where the API
 * actually listens in dev, so a relative request from a component that no
 * scenario answered resolves to a live address and opens a socket. Those land
 * late — measured: a run of nine files printed `connect ECONNREFUSED
 * 127.0.0.1:3001` under two files that issue no requests at all, because the
 * connection attempt outlived the file that started it and Bun attributed the
 * rejection to whichever file was running. Green counts, an error block, and a
 * stack pointing at the wrong test.
 *
 * Rejecting immediately keeps the failure inside the promise chain that made
 * the request, where React Query's error handling still sees it, and names the
 * request that had no double.
 */
function unreachableFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const url = input instanceof Request ? input.url : String(input);
  return Promise.reject(
    new Error(
      `[bun.setup] ${method.toUpperCase()} ${url} had no test double. Frontend tests do not reach the network — register the response with createFetchScenario().`
    )
  );
}

globalThis.fetch = unreachableFetch as unknown as typeof fetch;

class ResizeObserverMock {
  observe() {
    // noop – the layout it would report is never asserted on
  }
  unobserve() {
    // noop
  }
  disconnect() {
    // noop
  }
}

class IntersectionObserverMock {
  readonly root: Element | Document | null = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [];

  observe() {
    // noop – the layout it would report is never asserted on
  }
  unobserve() {
    // noop
  }
  disconnect() {
    // noop
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
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined as undefined,
    removeEventListener: () => undefined as undefined,
    dispatchEvent: () => false,
  }));

globalThis.ResizeObserver = ResizeObserverMock;
globalThis.IntersectionObserver =
  IntersectionObserverMock as unknown as typeof IntersectionObserver;

// Vitest's `globals: true` installs `cleanup` for us; `bun test` does not, and
// without it a second render in the same file finds the first one's DOM.
afterEach(() => {
  cleanup();
  resetTestSession();
  // A file that swapped `fetch` and did not put it back cannot poison the next
  // one in the shared process.
  globalThis.fetch = unreachableFetch as unknown as typeof fetch;
});
