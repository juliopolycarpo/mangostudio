import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigateToLoginPage, setAuthNavigate } from '../../../src/lib/auth-navigate';

function mockHandler() {
  // noop — test-only callback
}

function setPath(pathname: string) {
  window.history.replaceState({}, '', pathname);
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
    setPath('/');
  });

  afterEach(() => {
    vi.useRealTimers();
    setPath('/');
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
    setPath('/login');
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    vi.advanceTimersByTime(100);

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when already on /signup', async () => {
    setPath('/signup');
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    vi.advanceTimersByTime(100);

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when the user reaches an auth route during the debounce', async () => {
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    setPath('/login');
    vi.advanceTimersByTime(100);

    expect(navigate).not.toHaveBeenCalled();

    // Flag must re-arm even when the navigate is skipped.
    setPath('/');
    scheduleLoginRedirect();
    vi.advanceTimersByTime(100);
    expect(navigate).toHaveBeenCalledOnce();
  });
});
