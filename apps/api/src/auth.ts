import { apiKey } from '@better-auth/api-key';
import {
  API_KEY_HEADER,
  API_KEY_NAME_MAX_LENGTH,
  type ApiKeyScope,
} from '@mangostudio/shared/api-keys';
import { betterAuth } from 'better-auth';
import { getDb } from './db/database';
import { assertValidAuthSecret, getConfig } from './lib/config';

function createAuthInstance() {
  const config = getConfig();
  assertValidAuthSecret(config.auth.secret);

  return betterAuth({
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

    // A function, not `config.corsOrigins`: `getAuth()` memoizes this instance,
    // so an array captured here binds Better Auth's origin gate to whatever
    // config was live at the first call — under the shared-module-graph
    // integration lane, whichever test file reached `getAuth()` first. Better
    // Auth re-invokes this per request (dist/auth/base.mjs resolves the handler
    // context's trusted origins from it), so an origin the config gains after
    // initialization is honoured. Note the narrowing direction is weaker: the
    // origin-check middleware unions this result with the list it resolved at
    // context creation, so an origin *removed* after init stays trusted on that
    // path until the process restarts.
    trustedOrigins: () => getConfig().corsOrigins,

    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
      },
    },

    secret: config.auth.secret,
    baseURL: config.auth.url,

    plugins: [
      // @better-auth/api-key is a separately published package on the same
      // version line as better-auth. Bun's isolated linker materializes its
      // @better-auth/core peer as a byte-identical but nominally distinct
      // module instance from the one better-auth itself imports (a dual
      // package hazard), so the plugin's internal `hooks.before` shape fails
      // structural assignment against BetterAuthPlugin below even though the
      // two packages are functionally identical. This also means the
      // generic plugin-endpoint augmentation on `.api` does not pick up
      // verifyApiKey/createApiKey — see ApiKeyPluginApi/getApiKeyApi below
      // for the hand-typed accessor that works around it.
      // @ts-expect-error dual package hazard: see comment above.
      apiKey({
        apiKeyHeaders: API_KEY_HEADER,
        defaultPrefix: 'mango_',
        maximumNameLength: API_KEY_NAME_MAX_LENGTH,
        // The scope (read-only | full) is carried in key metadata.
        enableMetadata: true,
        // Load-bearing: installs a `before` hook that resolves the key header
        // into a session and short-circuits /get-session, so requireAuth's
        // existing getSession call authenticates key-bearing requests as-is.
        enableSessionForAPIKeys: true,
        // Defaults to on at 10 requests/day, which would break keys
        // immediately. plugins/rate-limit.ts's IP-based limiter stays the
        // only limiter.
        rateLimit: { enabled: false },
      }),
    ],
  });
}

type AuthInstance = ReturnType<typeof createAuthInstance>;

let authInstance: AuthInstance | null = null;

/**
 * Returns the cached Better Auth instance.
 * Lazy-initialized on first call to avoid module-level config reads.
 */
export function getAuth(): AuthInstance {
  if (!authInstance) {
    authInstance = createAuthInstance();
  }
  return authInstance;
}

/**
 * Resets the auth singleton (for tests).
 */
export function resetAuth(): void {
  authInstance = null;
}

/**
 * Shape of the two @better-auth/api-key endpoints this codebase calls,
 * hand-typed rather than relying on betterAuth()'s generic plugin-endpoint
 * augmentation — the dual-package-hazard cast on the `apiKey(...)` plugin
 * registration above prevents that augmentation from picking these up.
 * Kept intentionally narrow to the fields callers actually read.
 */
export interface ApiKeyPluginApi {
  createApiKey(options: {
    body: {
      userId?: string;
      name?: string;
      expiresIn?: number | null;
      metadata?: { scope: ApiKeyScope };
    };
    headers?: Headers;
  }): Promise<ApiKeyPluginRecord & { key: string }>;
  listApiKeys(options: {
    headers: Headers;
    query?: {
      sortBy?: string;
      sortDirection?: 'asc' | 'desc';
    };
  }): Promise<{
    apiKeys: ApiKeyPluginRecord[];
    total: number;
    limit?: number;
    offset?: number;
  }>;
  deleteApiKey(options: {
    body: { keyId: string };
    headers: Headers;
  }): Promise<{ success: boolean }>;
  verifyApiKey(options: { body: { key: string } }): Promise<{
    valid: boolean;
    error: { message?: string; code: string } | null;
    key: ApiKeyPluginRecord | null;
  }>;
}

/**
 * Narrow projection of Better Auth's API key record. The key hash is omitted:
 * only the create endpoint's intersection above may expose plaintext `key`.
 */
export interface ApiKeyPluginRecord {
  id: string;
  name: string | null;
  start: string | null;
  referenceId: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastRequest: Date | null;
  metadata: unknown;
}

/** Read the product scope from plugin metadata, defaulting unknown keys to least privilege. */
export function resolveApiKeyScope(metadata: unknown): ApiKeyScope {
  if (
    typeof metadata === 'object' &&
    metadata !== null &&
    'scope' in metadata &&
    metadata.scope === 'full'
  ) {
    return 'full';
  }
  return 'read-only';
}

/** Typed accessor for the api-key plugin's endpoints. See ApiKeyPluginApi. */
export function getApiKeyApi(): ApiKeyPluginApi {
  return getAuth().api as unknown as ApiKeyPluginApi;
}
