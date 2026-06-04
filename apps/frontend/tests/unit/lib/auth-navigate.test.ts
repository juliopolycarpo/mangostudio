import { describe, expect, it } from 'vitest';
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
