import { betterAuth } from 'better-auth';
import type { Auth } from 'better-auth';
import { getDb } from './db/database';
import { getConfig } from './lib/config';

let authInstance: Auth | null = null;

/**
 * Returns the cached Better Auth instance.
 * Lazy-initialized on first call to avoid module-level config reads.
 */
export function getAuth(): Auth {
  if (!authInstance) {
    const config = getConfig();

    authInstance = betterAuth({
      database: {
        db: getDb(),
        type: 'sqlite',
      },

      basePath: '/api/auth',

      emailAndPassword: {
        enabled: true,
        minPasswordLength: 8,
        maxPasswordLength: 128,
        autoSignIn: true,
      },

      trustedOrigins: config.corsOrigins,

      session: {
        cookieCache: {
          enabled: true,
          maxAge: 60 * 5,
        },
      },

      secret: config.auth.secret,
      baseURL: config.auth.url,
    }) as Auth;
  }
  return authInstance;
}

/**
 * Resets the auth singleton (for tests).
 */
export function resetAuth(): void {
  authInstance = null;
}
