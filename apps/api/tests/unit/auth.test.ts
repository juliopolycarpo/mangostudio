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
  // thing a split deployment can point at it is server.allowedOrigins.
  //
  // Deliberately structural. Better Auth reads its own environment, and
  // `bun test` sets NODE_ENV=test: `skipOriginCheck` defaults to `isTest()`
  // (better-auth/dist/context/create-context.mjs:210), so the origin and CSRF
  // checks are off for the whole of this suite — as are rate limiting (:171)
  // and secret validation (:40). A behavioural version of this test would send
  // an untrusted Origin, see 200, and assert nothing at all; its negative twin
  // would read that same 200 as a vulnerability. Neither is true: production
  // answers 403 INVALID_ORIGIN for a foreign origin on sign-up.
  //
  // So do not "upgrade" this to a request-path assertion. The behavioural half
  // lives in scripts/test-build.ts, which spawns the compiled binary with
  // NODE_ENV=production — the one place in this repo where the gate is live.
  // What this asserts is what actually regressed in #913: the configured list
  // never reaching Better Auth's options.
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
    // A function, not an array — see the note in src/auth.ts. Better Auth
    // resolves it per request, which is what keeps the memoized instance from
    // pinning the list to whatever config was live at the first getAuth().
    expect(typeof trustedOrigins).toBe('function');
    const resolved = (trustedOrigins as () => string[])();

    expect(resolved).toContain('https://studio.example.com');
    expect(resolved).toContain('http://localhost:3001');
    expect(resolved).not.toContain('https://attacker.example');
  });

  // The regression the function form buys, and the half an array cannot cover:
  // `getAuth()` is memoized, so a config loaded after the first call used to be
  // invisible to Better Auth for the life of the process. Ordering here is the
  // whole test — initialize first, configure second.
  it('sees an origin the config gains after the instance was built', () => {
    loadConfigForTest({
      auth: { secret: 'test-secret-at-least-32-characters-long', url: VALID_AUTH_URL },
      server: { host: '0.0.0.0', port: 3001, publicUrl: '', allowedOrigins: [] },
    });
    const { trustedOrigins } = getAuth().options;
    expect((trustedOrigins as () => string[])()).not.toContain('https://late.example.com');

    loadConfigForTest({
      auth: { secret: 'test-secret-at-least-32-characters-long', url: VALID_AUTH_URL },
      server: {
        host: '0.0.0.0',
        port: 3001,
        publicUrl: '',
        allowedOrigins: ['https://late.example.com'],
      },
    });

    expect((trustedOrigins as () => string[])()).toContain('https://late.example.com');
  });
});
