/**
 * A named fake standing in for GitHub and npm across every upgrade-resolution
 * test in this directory, so `resolveUpgradeTarget` and `downloadVerified` are
 * exercised against a fixed map of URL → response rather than the network.
 * Also supplies `resolveHostname`, so `safeFetchBytes`'s address policy runs
 * for real without doing DNS.
 */

export interface FakeReleaseHostRoute {
  readonly status?: number;
  readonly body?: string | Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
  /** Shorthand for a redirect route: sets status 302 and the `location` header. */
  readonly redirectTo?: string;
  /**
   * Answers 401 to any request that carries an `Authorization` header, the way
   * GitHub treats an expired token even on a public endpoint. Without the
   * header the route answers normally.
   */
  readonly rejectsAuthorization?: boolean;
}

export class FakeReleaseHost {
  readonly calls: string[] = [];
  /** The `AbortSignal` each call carried — undefined when no deadline was armed. */
  readonly signals: (AbortSignal | undefined)[] = [];
  /** The request headers each call carried, parallel to `calls`, names lower-cased. */
  readonly requestHeaders: Record<string, string>[] = [];
  private readonly routes: Map<string, FakeReleaseHostRoute>;

  constructor(routes: Readonly<Record<string, FakeReleaseHostRoute>>) {
    this.routes = new Map(Object.entries(routes));
  }

  readonly fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- The existing conversion accepts URL or arbitrary input and preserves its diagnostic representation.
    const url = String(input);
    this.calls.push(url);
    this.signals.push(init?.signal ?? undefined);
    this.requestHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
    const route = this.routes.get(url);
    if (!route) {
      throw new Error(`FakeReleaseHost has no route for ${url}`);
    }

    const requestHeaders = this.requestHeaders[this.requestHeaders.length - 1];
    if (route.rejectsAuthorization && requestHeaders?.authorization !== undefined) {
      return Promise.resolve(new Response('Bad credentials', { status: 401 }));
    }

    const status = route.redirectTo ? 302 : (route.status ?? 200);
    const headers = new Headers(route.headers);
    if (route.redirectTo) headers.set('location', route.redirectTo);
    return Promise.resolve(new Response(route.body ?? '', { status, headers }));
  }) as typeof fetch;

  /** The `authorization` value of each call, in order; undefined where none was sent. */
  authorizations(): (string | undefined)[] {
    return this.requestHeaders.map((headers) => headers.authorization);
  }

  /** Every hostname resolves to one fixed public address — no test here checks the address policy itself. */
  readonly resolveHostname = (_hostname: string): Promise<{ address: string; family: 4 | 6 }[]> =>
    Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
}
