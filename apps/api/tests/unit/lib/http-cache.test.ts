import { describe, expect, test } from 'bun:test';
import { isNotModified } from '../../../src/lib/http-cache';

const ETAG = '"9-18f0a1b2c3d"';
// A sub-second mtime: the case where a raw millisecond compare never matches.
const MTIME_MS = Date.UTC(2026, 8, 29, 12, 0, 0, 750);
const LAST_MODIFIED = new Date(MTIME_MS).toUTCString();

/** The answer the validators select, spelled so a failure names it. */
function answer(values: Record<string, string>): 'not modified' | 'send body' {
  return isNotModified(new Headers(values), ETAG, MTIME_MS) ? 'not modified' : 'send body';
}

describe('isNotModified', () => {
  test('is false for an unconditional request', () => {
    expect(answer({})).toBe('send body');
  });

  test('matches If-None-Match through the shared ETag comparison', () => {
    expect(answer({ 'if-none-match': ETAG })).toBe('not modified');
    expect(answer({ 'if-none-match': `W/${ETAG}` })).toBe('not modified');
    expect(answer({ 'if-none-match': '"other"' })).toBe('send body');
  });

  test('matches an echoed Last-Modified despite its second precision', () => {
    expect(answer({ 'if-modified-since': LAST_MODIFIED })).toBe('not modified');
  });

  test('is false when the file changed after If-Modified-Since', () => {
    const earlier = new Date(MTIME_MS - 60_000).toUTCString();
    expect(answer({ 'if-modified-since': earlier })).toBe('send body');
  });

  test('ignores If-Modified-Since when If-None-Match is present', () => {
    expect(answer({ 'if-none-match': '"other"', 'if-modified-since': LAST_MODIFIED })).toBe(
      'send body'
    );
  });

  test('is false for an unparseable If-Modified-Since', () => {
    expect(answer({ 'if-modified-since': 'yesterday' })).toBe('send body');
  });
});
