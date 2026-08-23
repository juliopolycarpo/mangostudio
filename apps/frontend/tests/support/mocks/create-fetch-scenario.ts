import { jest } from 'bun:test';

export type FetchScenarioKey = `${string} ${string}`;

interface FetchScenarioResponse {
  body?: unknown;
  headers?: HeadersInit;
  status?: number;
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The mock surface the scenario exposes, spelled out rather than inferred from
 * `jest.fn`'s return type.
 *
 * The declared interface is what 37 test files' type inference hangs off, and
 * `settings-page-secret.integration.test.tsx` names it explicitly — keep it
 * narrower than `Mock` so a scenario can only be driven through the calls the
 * helper actually supports.
 */
export interface FetchScenarioMock {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readonly mock: { readonly calls: [RequestInfo | URL, (RequestInit | undefined)?][] };
  mockClear(): unknown;
  mockImplementation(implementation: FetchImplementation): unknown;
  mockResolvedValue(value: Response): unknown;
  getMockImplementation(): FetchImplementation | undefined;
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
 * `use-gallery-query`) que disparam `fetch` via Eden Treaty no ambiente DOM
 * simulado — onde o app Elysia não está disponível.
 *
 * Para testes de contrato de API, prefira `createApiTestApp` + `app.handle()`
 * no workspace `@mangostudio/api`.
 *
 * @returns Helpers to register mocked responses and install a global fetch mock.
 */
export function createFetchScenario() {
  const originalFetch = globalThis.fetch;
  const responses = new Map<FetchScenarioKey, FetchScenarioResponse>();
  // `jest.fn` is generic over the implementation it wraps, so it satisfies the
  // declared surface structurally but not nominally. `FetchScenarioMock` is
  // what the scenario's consumers are held to.
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const method = getRequestMethod(input, init);
    const url = getRequestUrl(input);
    const key = `${method} ${url.pathname}${url.search}` as FetchScenarioKey;
    const response = responses.get(key);

    if (!response) {
      return Promise.reject(new Error(`[fetch-scenario] Unhandled request: ${key}`));
    }

    // A bodyless mock must not claim `application/json`: Eden Treaty parses by
    // Content-Type, so an empty body behind that header makes `JSON.parse('')`
    // throw and turns a real 204 into a client-side failure. Elysia sends no
    // Content-Type on 204, so neither does this mock.
    const hasBody = response.body !== undefined;

    return Promise.resolve(
      new Response(hasBody ? JSON.stringify(response.body) : null, {
        status: response.status ?? 200,
        headers: {
          ...(hasBody && { 'Content-Type': 'application/json' }),
          ...response.headers,
        },
      })
    );
  }) as unknown as FetchScenarioMock;

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
      responses.set(`${method.toUpperCase()} ${path}`, response);
      return this;
    },

    /**
     * Installs the scenario fetch mock on globalThis.
     */
    install() {
      // Assigned directly — `bun test` has no runner-managed global stubbing,
      // so `restore()` puts back the captured original itself.
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      return this;
    },

    /**
     * Restores the previous global fetch implementation.
     */
    restore() {
      responses.clear();
      // `mockClear`, not `mockReset`: under `bun test` a reset strips the
      // implementation `jest.fn(impl)` was given, so the second test in a file
      // would get a `fetch` that returns `undefined` and every request after
      // it fails.
      fetchMock.mockClear();
      globalThis.fetch = originalFetch;
    },
  };
}
