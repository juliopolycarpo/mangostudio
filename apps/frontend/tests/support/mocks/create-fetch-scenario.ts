export type FetchScenarioKey = `${string} ${string}`;

interface FetchScenarioResponse {
  body?: unknown;
  headers?: HeadersInit;
  status?: number;
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The mock surface the scenario exposes, spelled out rather than inferred from
 * a runner's `vi.fn` / `jest.fn` return type.
 *
 * Naming it here is what lets one helper serve both test lanes: `bun test` and
 * Vitest each supply their own factory (below), and both runners' `expect`
 * recognizes their own mock for `toHaveBeenCalledTimes` / `toHaveBeenCalledWith`.
 */
export interface FetchScenarioMock {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readonly mock: { readonly calls: [RequestInfo | URL, (RequestInit | undefined)?][] };
  mockClear(): unknown;
  mockImplementation(implementation: FetchImplementation): unknown;
  mockResolvedValue(value: Response): unknown;
  getMockImplementation(): FetchImplementation | undefined;
}

export type FetchScenarioMockFactory = (implementation: FetchImplementation) => FetchScenarioMock;

let mockFactory: FetchScenarioMockFactory | undefined;

/**
 * Installs the active runner's mock factory.
 *
 * Called once per test file from the lane's setup: `bun.setup.ts` passes
 * `jest.fn`, `vitest.setup.ts` passes `vi.fn`. Keeping the choice out of this
 * module is what keeps `vitest` out of the `bun test` module graph — importing
 * it here would work, but it would put the whole Vitest runtime behind 37 test
 * files that no longer use it.
 */
export function setFetchMockFactory(factory: FetchScenarioMockFactory): void {
  mockFactory = factory;
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
  if (!mockFactory) {
    throw new Error(
      'createFetchScenario() ran before setFetchMockFactory(). The test lane setup did not load — check `[test] preload` in bunfig.toml, or `setupFiles` in vitest.config.ts.'
    );
  }

  const originalFetch = globalThis.fetch;
  const responses = new Map<FetchScenarioKey, FetchScenarioResponse>();
  const fetchMock = mockFactory((input: RequestInfo | URL, init?: RequestInit) => {
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
      responses.set(`${method.toUpperCase()} ${path}`, response);
      return this;
    },

    /**
     * Installs the scenario fetch mock on globalThis.
     */
    install() {
      // Assigned directly rather than through `vi.stubGlobal`, which does not
      // exist under `bun test`. Both lanes restore the captured original in
      // `restore()`, so nothing depends on a runner-managed unstub.
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      return this;
    },

    /**
     * Restores the previous global fetch implementation.
     */
    restore() {
      responses.clear();
      // `mockClear`, not `mockReset`: the two runners disagree about what reset
      // means. Vitest puts back the implementation `vi.fn(impl)` was given;
      // jest and `bun test` strip it, so the second test in a file would get a
      // `fetch` that returns `undefined` and every request after it fails.
      fetchMock.mockClear();
      globalThis.fetch = originalFetch;
    },
  };
}
