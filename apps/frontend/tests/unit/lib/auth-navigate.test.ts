import { beforeEach, describe, expect, it, vi } from 'vitest';
import { navigateToLoginPage, setAuthNavigate } from '../../../src/lib/auth-navigate';

function mockHandler() {
  // noop — test-only callback
}

describe('auth-navigate', () => {
  it('calls the registered handler when navigating', () => {
    let called = false;
    setAuthNavigate(() => {
      called = true;
    });
    navigateToLoginPage();
    expect(called).toBe(true);
  });

  it('does not throw when no handler is set', () => {
    setAuthNavigate(mockHandler);
    navigateToLoginPage();
    setAuthNavigate(null as unknown as () => void);
    expect(() => navigateToLoginPage()).not.toThrow();
  });

  it('replaces the previous handler', () => {
    let first = false;
    let second = false;
    setAuthNavigate(() => {
      first = true;
    });
    setAuthNavigate(() => {
      second = true;
    });
    navigateToLoginPage();
    expect(first).toBe(false);
    expect(second).toBe(true);
  });
});

describe('scheduleLoginRedirect', () => {
  let navigate = vi.fn();

  beforeEach(() => {
    navigate = vi.fn();
    // A fresh module instance per test so the debounce flag never leaks.
    vi.resetModules();
    vi.useFakeTimers();

    // Replace jsdom's non-configurable location with a mutable plain object
    // @ts-expect-error jsdom allows deleting window.location
    window.location = undefined;
    // @ts-expect-error assigning a plain object to window.location
    window.location = { href: 'http://localhost:3000/', pathname: '/' };
  });

  async function loadModule() {
    const authNavigate = await import('../../../src/lib/auth-navigate');
    authNavigate.setAuthNavigate(navigate);
    return authNavigate;
  }

  it('navigates after the debounce window', async () => {
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    expect(navigate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('does not navigate multiple times for concurrent calls', async () => {
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    scheduleLoginRedirect();

    vi.advanceTimersByTime(100);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the redirect fires so later sessions still redirect', async () => {
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    vi.advanceTimersByTime(100);
    scheduleLoginRedirect();
    vi.advanceTimersByTime(100);

    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('does not navigate when already on /login', async () => {
    // @ts-expect-error test-only replacement of jsdom location
    window.location = { href: 'http://localhost:3000/login', pathname: '/login' };
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    vi.advanceTimersByTime(100);

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when already on /signup', async () => {
    // @ts-expect-error test-only replacement of jsdom location
    window.location = { href: 'http://localhost:3000/signup', pathname: '/signup' };
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    vi.advanceTimersByTime(100);

    expect(navigate).not.toHaveBeenCalled();
  });
});
