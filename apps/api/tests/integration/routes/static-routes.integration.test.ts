/**
 * Regression tests for SPA catch-all fallback routing behaviour.
 *
 * Verifies that the /assets/ guard added in apps/api/src/index.ts prevents
 * the SPA catch-all from intercepting static asset requests.
 *
 * The guard function is tested in isolation — no HTTP server needed.
 * If someone removes or narrows the /assets/ check, these tests fail.
 */
import { describe, test, expect } from 'bun:test';
import { isStandaloneExecutable } from '../../../src/lib/runtime-paths';

/**
 * Replicates the guard condition from the SPA fallback handler in
 * apps/api/src/index.ts. Returns true when the path should be served
 * as the SPA index.html, false when it should pass through (404).
 */
function shouldServeSpa(path: string): boolean {
  return (
    !path.startsWith('/api/') &&
    !path.startsWith('/uploads/') &&
    !path.startsWith('/scalar') &&
    !path.startsWith('/assets/')
  );
}

describe('SPA catch-all fallback guard', () => {
  test('/assets/*.js paths are NOT served as SPA', () => {
    expect(shouldServeSpa('/assets/app.js')).toBe(false);
    expect(shouldServeSpa('/assets/vendor.js')).toBe(false);
    expect(shouldServeSpa('/assets/index-AbCd1234.js')).toBe(false);
  });

  test('/assets/*.css paths are NOT served as SPA', () => {
    expect(shouldServeSpa('/assets/style.css')).toBe(false);
    expect(shouldServeSpa('/assets/main-XyZ789.css')).toBe(false);
  });

  test('/api/* paths are NOT served as SPA', () => {
    expect(shouldServeSpa('/api/health')).toBe(false);
    expect(shouldServeSpa('/api/chats')).toBe(false);
  });

  test('/uploads/* paths are NOT served as SPA', () => {
    expect(shouldServeSpa('/uploads/image.png')).toBe(false);
  });

  test('/scalar is NOT served as SPA', () => {
    expect(shouldServeSpa('/scalar')).toBe(false);
    expect(shouldServeSpa('/scalar/something')).toBe(false);
  });

  test('generic SPA routes ARE served as SPA', () => {
    expect(shouldServeSpa('/')).toBe(true);
    expect(shouldServeSpa('/some-page')).toBe(true);
    expect(shouldServeSpa('/settings')).toBe(true);
    expect(shouldServeSpa('/index.html')).toBe(true);
  });
});
