/**
 * Regression tests for SPA onError NOT_FOUND fallback routing behaviour.
 *
 * Verifies that isSpaRoute() correctly identifies which paths should be
 * served as index.html and which should pass through as 404.
 *
 * The guard function is tested in isolation — no HTTP server needed.
 * If someone narrows or removes checks inside isSpaRoute(), these tests fail.
 */
import { describe, expect, test } from 'bun:test';
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

  test('/api and /api/* paths are NOT served as SPA', () => {
    expect(isSpaRoute('/api')).toBe(false);
    expect(isSpaRoute('/api/health')).toBe(false);
    expect(isSpaRoute('/api/chats')).toBe(false);
  });

  test('/api/auth/* paths are NOT served as SPA', () => {
    expect(isSpaRoute('/api/auth/get-session')).toBe(false);
    expect(isSpaRoute('/api/auth/sign-in/email')).toBe(false);
  });

  test('/uploads and /uploads/* paths are NOT served as SPA', () => {
    expect(isSpaRoute('/uploads')).toBe(false);
    expect(isSpaRoute('/uploads/image.png')).toBe(false);
    expect(isSpaRoute('/uploads/Chat_chat-id/1710000000000/file.png')).toBe(false);
  });

  test('/images and /images/* paths are NOT served as SPA', () => {
    expect(isSpaRoute('/images')).toBe(false);
    expect(isSpaRoute('/images/generated.png')).toBe(false);
  });

  test('/scalar and /scalar/* paths are NOT served as SPA', () => {
    expect(isSpaRoute('/scalar')).toBe(false);
    expect(isSpaRoute('/scalar/something')).toBe(false);
  });

  test('/assets and /assets/* paths are NOT served as SPA', () => {
    expect(isSpaRoute('/assets')).toBe(false);
    expect(isSpaRoute('/assets/app.js')).toBe(false);
  });

  test('percent-encoded API, asset, and root-file paths are NOT served as SPA', () => {
    expect(isSpaRoute('/%61pi/nope')).toBe(false);
    expect(isSpaRoute('/%61ssets/missing.js')).toBe(false);
    expect(isSpaRoute('/api%2fnope')).toBe(false);
    expect(isSpaRoute('/never-built%2esvg')).toBe(false);
  });

  test('malformed and unsafe decoded paths are NOT served as SPA', () => {
    expect(isSpaRoute('/%ZZ/nope')).toBe(false);
    expect(isSpaRoute('/..%2fsecret.svg')).toBe(false);
    expect(isSpaRoute('/route%5csecret')).toBe(false);
    expect(isSpaRoute('/route%00secret')).toBe(false);
  });

  test('lookalike path segments ARE served as SPA', () => {
    expect(isSpaRoute('/apiary')).toBe(true);
    expect(isSpaRoute('/uploads-old')).toBe(true);
    expect(isSpaRoute('/images-archive')).toBe(true);
    expect(isSpaRoute('/assets-page')).toBe(true);
    expect(isSpaRoute('/scalarity')).toBe(true);
    expect(isSpaRoute('/%61piary')).toBe(true);
  });

  test('generic SPA routes ARE served as SPA', () => {
    expect(isSpaRoute('/')).toBe(true);
    expect(isSpaRoute('/some-page')).toBe(true);
    expect(isSpaRoute('/settings')).toBe(true);
    expect(isSpaRoute('/index.html')).toBe(true);
  });

  test('root-level file requests are NOT served as SPA', () => {
    // Every unhashed file the build emits has this shape, because public/ is
    // flat. If one of these is missing, the honest answer is 404 — handing an
    // <img> or <link> a 200 text/html shell fails silently, with no server
    // error and nothing in the log to point at the real cause.
    expect(isSpaRoute('/favicon.ico')).toBe(false);
    expect(isSpaRoute('/site.webmanifest')).toBe(false);
    expect(isSpaRoute('/apple-touch-icon.png')).toBe(false);
    expect(isSpaRoute('/logo.svg')).toBe(false);
  });

  test('dotted paths that are not root-level files ARE still served as SPA', () => {
    // The rule is anchored to a single segment on purpose. `$resourceKey`
    // accepts a dotted key, so a nested dotted path is a live SPA route and
    // claiming every dot for the filesystem would 404 links that work today.
    expect(isSpaRoute('/library/my-skill.md')).toBe(true);
    expect(isSpaRoute('/settings/providers/openai.com')).toBe(true);
    expect(isSpaRoute('/library/my-skill%2emd')).toBe(true);
    // No extension, so not a file request even at the root.
    expect(isSpaRoute('/some.page/nested')).toBe(true);
  });
});
