import '@testing-library/jest-dom';
import { vi } from 'vitest';
import { type FetchScenarioMockFactory, setFetchMockFactory } from '../mocks/create-fetch-scenario';

// The fetch scenario no longer imports a runner; each lane supplies its own
// mock factory so that `expect(fetchMock).toHaveBeenCalledWith(...)` keeps
// working under whichever `expect` is in scope. `bun.setup.ts` passes `jest.fn`.
setFetchMockFactory(vi.fn as unknown as FetchScenarioMockFactory);

/**
 * Keeps the real Better Auth client out of the suite.
 *
 * `useRealtimeInvalidation` reads the session, so every component that syncs
 * anything — environments, library, settings, git — subscribes Better Auth's
 * session atom. nanostores tears an atom down one second after its last
 * listener goes away, and that disposer removes a `window` event listener.
 * Under load the timer lands after Vitest disposed the file's jsdom
 * environment, so the run dies with an unhandled `ReferenceError: window is not
 * defined` while every test still reports green.
 *
 * The stub reports a signed-out session, which is what the real client resolved
 * to here anyway: no test serves `/api/auth/get-session`. A test that needs a
 * session mocks this module itself — a mock declared in the test file is
 * registered after this one and wins.
 */
vi.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false }),
    signIn: { email: unstubbed('signIn.email') },
    signUp: { email: unstubbed('signUp.email') },
    signOut: unstubbed('signOut'),
  },
}));

function unstubbed(method: string) {
  return () => {
    throw new Error(
      `authClient.${method} is not stubbed globally; mock '@/lib/auth-client' in this test.`
    );
  };
}

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
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined as undefined,
    removeEventListener: () => undefined as undefined,
    dispatchEvent: () => false,
  }));

globalThis.ResizeObserver = ResizeObserverMock;
globalThis.IntersectionObserver =
  IntersectionObserverMock as unknown as typeof IntersectionObserver;
