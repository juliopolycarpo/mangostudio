import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getAuth, resetAuth } from '../../src/auth';
import { loadConfigForTest } from '../../src/lib/config';

const VALID_AUTH_URL = 'http://localhost:3001';

beforeEach(() => {
  resetAuth();
});

afterEach(() => {
  resetAuth();
  loadConfigForTest({
    auth: { secret: 'test-secret-at-least-32-characters-long', url: VALID_AUTH_URL },
  });
});

describe('getAuth', () => {
  it('fails before Better Auth initializes when the secret is missing', () => {
    loadConfigForTest({ auth: { secret: '', url: VALID_AUTH_URL } });

    expect(() => getAuth()).toThrow(/BETTER_AUTH_SECRET is required/);
  });

  it('fails before Better Auth initializes when the secret is too short', () => {
    loadConfigForTest({ auth: { secret: 'short', url: VALID_AUTH_URL } });

    expect(() => getAuth()).toThrow(/BETTER_AUTH_SECRET must be at least 32 characters/);
  });
});
