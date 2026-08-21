import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { navigateToLoginPage, setAuthNavigate } from '../../../src/lib/auth-navigate';
import {
  advanceTimersByTimeAsync,
  restoreRealTimers,
  useFakeTimers,
} from '../../support/harness/timers';

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
  let navigate = jest.fn();

  beforeEach(() => {
    navigate = jest.fn();
    // Vitest reset the module here so the debounce flag could not leak. There
    // is no `jest.resetModules()` under `bun test`, and none is needed: the
    // flag re-arms in the timer's own `finally`, and every case below advances
    // past the 100ms window before it ends.
    useFakeTimers();
    setPath('/');
  });

  afterEach(async () => {
    await restoreRealTimers();
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

    await advanceTimersByTimeAsync(100);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('does not navigate multiple times for concurrent calls', async () => {
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    scheduleLoginRedirect();

    await advanceTimersByTimeAsync(100);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the redirect fires so later sessions still redirect', async () => {
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    await advanceTimersByTimeAsync(100);
    scheduleLoginRedirect();
    await advanceTimersByTimeAsync(100);

    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('does not navigate when already on /login', async () => {
    setPath('/login');
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    await advanceTimersByTimeAsync(100);

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when already on /signup', async () => {
    setPath('/signup');
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    await advanceTimersByTimeAsync(100);

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when the user reaches an auth route during the debounce', async () => {
    const { scheduleLoginRedirect } = await loadModule();

    scheduleLoginRedirect();
    setPath('/login');
    await advanceTimersByTimeAsync(100);

    expect(navigate).not.toHaveBeenCalled();

    // Flag must re-arm even when the navigate is skipped.
    setPath('/');
    scheduleLoginRedirect();
    await advanceTimersByTimeAsync(100);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
