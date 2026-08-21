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

  // Better Auth is one of three gates reading cfg.corsOrigins, and the only
  // thing a split deployment can point at it is server.allowedOrigins. Asserted
  // on the options Better Auth was built with rather than on a rejected
  // request: no endpoint this app enables refuses an untrusted Origin header,
  // so the request path would pass either way and prove nothing.
  it('trusts the configured allowed origins alongside the server origin', () => {
    loadConfigForTest({
      auth: { secret: 'test-secret-at-least-32-characters-long', url: VALID_AUTH_URL },
      server: {
        host: '0.0.0.0',
        port: 3001,
        publicUrl: '',
        allowedOrigins: ['https://studio.example.com'],
      },
    });

    const { trustedOrigins } = getAuth().options;

    expect(trustedOrigins).toContain('https://studio.example.com');
    expect(trustedOrigins).toContain('http://localhost:3001');
    expect(trustedOrigins).not.toContain('https://attacker.example');
  });
});
