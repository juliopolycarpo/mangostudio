/**
 * `getGithubApiToken` reads the token the way the install scripts do. Every
 * value here is a dummy; no real credential belongs in a test.
 */

import { describe, expect, it } from 'bun:test';

import { getGithubApiToken } from '../../../src/lib/config';

describe('getGithubApiToken', () => {
  it('prefers GITHUB_TOKEN over GH_TOKEN', () => {
    expect(getGithubApiToken({ GITHUB_TOKEN: 'dummy-primary', GH_TOKEN: 'dummy-fallback' })).toBe(
      'dummy-primary'
    );
  });

  it('falls back to GH_TOKEN when GITHUB_TOKEN is unset or empty', () => {
    expect(getGithubApiToken({ GH_TOKEN: 'dummy-fallback' })).toBe('dummy-fallback');
    expect(getGithubApiToken({ GITHUB_TOKEN: '', GH_TOKEN: 'dummy-fallback' })).toBe(
      'dummy-fallback'
    );
    expect(getGithubApiToken({ GITHUB_TOKEN: '   ', GH_TOKEN: 'dummy-fallback' })).toBe(
      'dummy-fallback'
    );
  });

  it('is undefined when neither variable holds a value', () => {
    expect(getGithubApiToken({})).toBeUndefined();
    expect(getGithubApiToken({ GITHUB_TOKEN: '', GH_TOKEN: '' })).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(getGithubApiToken({ GITHUB_TOKEN: '  dummy-token\n' })).toBe('dummy-token');
  });

  it('drops a value with inner whitespace or control characters instead of sending it', () => {
    for (const value of ['dummy token', 'dummy\ttoken', 'dummy\r\nX-Injected: 1', 'dummy\u0000']) {
      expect(getGithubApiToken({ GITHUB_TOKEN: value })).toBeUndefined();
    }
  });
});
