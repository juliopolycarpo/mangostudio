import { describe, expect, it } from 'vitest';
import { safeRedirect } from '../../../src/lib/safe-redirect';

describe('safeRedirect', () => {
  it('returns / for nullish input', () => {
    expect(safeRedirect(null)).toBe('/');
    expect(safeRedirect(undefined)).toBe('/');
    expect(safeRedirect('')).toBe('/');
  });

  it('returns app-relative paths unchanged', () => {
    expect(safeRedirect('/chat')).toBe('/chat');
    expect(safeRedirect('/settings/general')).toBe('/settings/general');
  });

  it('parses same-origin full URLs to app-relative paths', () => {
    expect(safeRedirect('http://localhost:3000/chat')).toBe('/chat');
    expect(safeRedirect(`${window.location.origin}/gallery`)).toBe('/gallery');
  });

  it('preserves search and hash from same-origin URLs', () => {
    expect(safeRedirect('http://localhost:3000/chat?q=hello')).toBe('/chat?q=hello');
    expect(safeRedirect(`${window.location.origin}/page#section`)).toBe('/page#section');
  });

  it('rejects cross-origin URLs and returns /', () => {
    expect(safeRedirect('https://evil.com/phishing')).toBe('/');
  });

  it('rejects protocol-relative URLs', () => {
    expect(safeRedirect('//evil.com/phishing')).toBe('/');
  });

  it('rejects backslash protocol-relative URLs', () => {
    expect(safeRedirect('/\\evil.com/phishing')).toBe('/');
  });

  it('rejects control-char protocol-relative URLs that browsers normalize to "//"', () => {
    // Browsers/the URL parser strip tab, LF, and CR, so "/\n/evil.com" would
    // otherwise resolve to the protocol-relative "//evil.com".
    expect(safeRedirect('/\n/evil.com')).toBe('/');
    expect(safeRedirect('/\t/evil.com')).toBe('/');
    expect(safeRedirect('/\r/evil.com')).toBe('/');
  });

  it('rejects bare protocol URLs', () => {
    expect(safeRedirect('https://evil.com')).toBe('/');
    expect(safeRedirect('http://evil.com')).toBe('/');
  });

  it('rejects non-absolute paths', () => {
    expect(safeRedirect('chat')).toBe('/');
    expect(safeRedirect('../admin')).toBe('/');
  });

  it('trims whitespace', () => {
    expect(safeRedirect('  /chat  ')).toBe('/chat');
  });
});
