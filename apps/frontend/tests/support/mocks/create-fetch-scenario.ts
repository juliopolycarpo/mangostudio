import { vi } from 'vitest';

export type FetchScenarioKey = `${string} ${string}`;

interface FetchScenarioResponse {
  body?: unknown;
  headers?: HeadersInit;
  status?: number;
}

function getRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }

  if (input instanceof URL) {
    return input;
  }

  return new URL(input, 'http://localhost');
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }

  if (input instanceof Request) {
    return input.method.toUpperCase();
  }

  return 'GET';
}

/**
 * Creates a fetch scenario registry for frontend integration tests.
 *
 * **Escopo:** Use exclusivamente em testes de hooks React (ex: `use-messages-query`,
 * `use-gallery-query`) que disparam `fetch` via Eden Treaty no ambiente jsdom —
 * onde o app Elysia não está disponível.
 *
 * Para testes de contrato de API, prefira `createApiTestApp` + `app.handle()`
 * no workspace `@mangostudio/api`.
 *
 * @returns Helpers to register mocked responses and install a global fetch mock.
 */
export function createFetchScenario() {
  const originalFetch = globalThis.fetch;
  const responses = new Map<FetchScenarioKey, FetchScenarioResponse>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = getRequestMethod(input, init);
    const url = getRequestUrl(input);
    const key = `${method} ${url.pathname}${url.search}` as FetchScenarioKey;
    const response = responses.get(key);

    if (!response) {
      throw new Error(`[fetch-scenario] Unhandled request: ${key}`);
    }

    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: {
        'Content-Type': 'application/json',
        ...response.headers,
      },
    });
  });

  return {
    fetchMock,

    /**
     * Registers a JSON response for a method and path pair.
     *
     * @param method - HTTP method.
     * @param path - Request path, including optional search params.
     * @param response - Mock response details.
     */
    respondWithJson(method: string, path: string, response: FetchScenarioResponse = {}) {
      responses.set(`${method.toUpperCase()} ${path}` as FetchScenarioKey, response);
      return this;
    },

    /**
     * Installs the scenario fetch mock on globalThis.
     */
    install() {
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
      return this;
    },

    /**
     * Restores the previous global fetch implementation.
     */
    restore() {
      responses.clear();
      fetchMock.mockReset();

      if (originalFetch) {
        vi.stubGlobal('fetch', originalFetch);
      } else {
        vi.unstubAllGlobals();
      }
    },
  };
}
