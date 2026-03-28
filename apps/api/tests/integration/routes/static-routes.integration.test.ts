/**
 * Regression tests for SPA onError NOT_FOUND fallback routing behaviour.
 *
 * Verifies that isSpaRoute() correctly identifies which paths should be
 * served as index.html and which should pass through as 404.
 *
 * The guard function is tested in isolation — no HTTP server needed.
 * If someone narrows or removes checks inside isSpaRoute(), these tests fail.
 */
import { describe, test, expect } from 'bun:test';
import { isStandaloneExecutable } from '../../../src/lib/runtime-paths';
import { isSpaRoute } from '../../../src/lib/spa-guard';

describe('SPA onError NOT_FOUND guard', () => {
  test('/assets/*.js paths are NOT served as SPA', () => {
    expect(isSpaRoute('/assets/app.js')).toBe(false);
    expect(isSpaRoute('/assets/vendor.js')).toBe(false);
    expect(isSpaRoute('/assets/index-AbCd1234.js')).toBe(false);
  });

  test('/assets/*.css paths are NOT served as SPA', () => {
    expect(isSpaRoute('/assets/style.css')).toBe(false);
    expect(isSpaRoute('/assets/main-XyZ789.css')).toBe(false);
  });

  test('/api/* paths are NOT served as SPA', () => {
    expect(isSpaRoute('/api/health')).toBe(false);
    expect(isSpaRoute('/api/chats')).toBe(false);
  });

  test('/api/auth/* paths are NOT served as SPA', () => {
    expect(isSpaRoute('/api/auth/get-session')).toBe(false);
    expect(isSpaRoute('/api/auth/sign-in/email')).toBe(false);
  });

  test('/uploads/* paths are NOT served as SPA', () => {
    expect(isSpaRoute('/uploads/image.png')).toBe(false);
  });

  test('/scalar is NOT served as SPA', () => {
    expect(isSpaRoute('/scalar')).toBe(false);
    expect(isSpaRoute('/scalar/something')).toBe(false);
  });

  test('generic SPA routes ARE served as SPA', () => {
    expect(isSpaRoute('/')).toBe(true);
    expect(isSpaRoute('/some-page')).toBe(true);
    expect(isSpaRoute('/settings')).toBe(true);
    expect(isSpaRoute('/index.html')).toBe(true);
  });
});
