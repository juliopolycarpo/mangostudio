/**
 * Shared helpers for connector route integration tests.
 *
 * Connector tests repeatedly (a) stub `globalThis.fetch` so provider key
 * validation does not hit the network, and (b) re-register the real
 * openai / base-url-policy modules afterwards, because `mock.restore()` does
 * NOT revert `mock.module()` overrides. Centralizing both removes the most
 * error-prone boilerplate from individual tests.
 */

import { mock } from 'bun:test';
import { Type } from '@sinclair/typebox';
import {
  UnsafeBaseUrlError,
  validateBaseUrl,
} from '../../../src/services/providers/core/base-url-policy';
import {
  OpenAIAuthError,
  OpenAIConfigError,
  validateOpenAIAuthContext,
} from '../../../src/services/providers/openai/index';

// Capture the real implementations at module-load time, before any test can
// override them via mock.module().
const realValidateOpenAIAuthContext = validateOpenAIAuthContext;
const realValidateBaseUrl = validateBaseUrl;

type FetchImpl = typeof globalThis.fetch;

/** Connector list/CRUD response shapes used across connector route tests. */
export interface ConnectorEntry {
  id: string;
  userId: string | null;
  provider: string;
  name: string;
  baseUrl: string | null;
  configured: boolean;
  enabledModels?: string[];
  accountLabel?: string | null;
  planType?: string | null;
  needsReauth?: boolean;
}
export interface ConnectorListPayload {
  connectors: ConnectorEntry[];
}
export interface ConnectorPayload {
  id: string;
  provider: string;
  baseUrl: string | null;
  configured: boolean;
}
export interface ErrorPayload {
  error: string;
  code?: string;
}
export interface SuccessPayload {
  success: boolean;
}
export interface ModelCatalogPayload {
  status: string;
  textModels: unknown[];
  imageModels: unknown[];
}

/** Schema for a single connector create/read response. */
export const ConnectorResponseSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  provider: Type.String(),
  configured: Type.Boolean(),
  source: Type.String(),
  baseUrl: Type.Union([Type.String(), Type.Null()]),
});

/**
 * True when `rawUrl` targets `<hostname>`'s model-listing endpoint. Matches the
 * parsed host and path instead of a substring so a deceptive host such as
 * `api.openai.com.evil.test` does not satisfy the stub (CodeQL
 * js/incomplete-url-substring-sanitization).
 * // Usage: isProviderModelsUrl(url, 'api.openai.com')
 */
export function isProviderModelsUrl(rawUrl: string, hostname: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return parsed.hostname === hostname && parsed.pathname.endsWith('/models');
}

/**
 * Returns a fetch that answers OpenAI `/models` calls with a minimal 200 model
 * list and forwards everything else. // Usage: globalThis.fetch = makeOpenAISuccessFetch(globalThis.fetch)
 */
export function makeOpenAISuccessFetch(originalFetch: FetchImpl): FetchImpl {
  // biome-ignore lint/suspicious/useAwait: matches the fetch signature
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (isProviderModelsUrl(url, 'api.openai.com')) {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4o', object: 'model', created: 0, owned_by: 'openai' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return originalFetch(input, init);
  }) as FetchImpl;
}

/**
 * Returns a fetch that answers a single `<baseUrl>/models` call with an empty
 * 200 list and forwards everything else — for openai-compatible/deepseek tests.
 */
export function makeModelsEndpointFetch(originalFetch: FetchImpl, modelsUrl: string): FetchImpl {
  // biome-ignore lint/suspicious/useAwait: matches the fetch signature
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === modelsUrl) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return originalFetch(input, init);
  }) as FetchImpl;
}

/**
 * Runs `body` with `globalThis.fetch` replaced by `fetchImpl`, restoring the
 * original fetch even if the body throws. Removes the repetitive
 * try/finally save/restore dance. // Usage: await withFetch(makeOpenAISuccessFetch(globalThis.fetch), async () => {...})
 */
export async function withFetch<T>(fetchImpl: FetchImpl, body: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await body();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** Mocks base-url validation to always pass (avoids DNS lookups in tests). */
export async function allowAnyBaseUrl(): Promise<void> {
  await mock.module('../../../src/services/providers/core/base-url-policy', () => ({
    validateBaseUrl: () => Promise.resolve(),
    UnsafeBaseUrlError,
  }));
}

/**
 * Re-registers the real openai and base-url-policy modules. Call in `afterEach`
 * of any connector test that used mock.module on them, so the overrides do not
 * leak into other tests. // Usage: afterEach(restoreConnectorProviderMocks)
 */
export async function restoreConnectorProviderMocks(): Promise<void> {
  await mock.module('../../../src/services/providers/openai/index', () => ({
    validateOpenAIAuthContext: realValidateOpenAIAuthContext,
    OpenAIAuthError,
    OpenAIConfigError,
  }));
  await mock.module('../../../src/services/providers/core/base-url-policy', () => ({
    validateBaseUrl: realValidateBaseUrl,
    UnsafeBaseUrlError,
  }));
}
