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
}

export class FakeReleaseHost {
  readonly calls: string[] = [];
  private readonly routes: Map<string, FakeReleaseHostRoute>;

  constructor(routes: Readonly<Record<string, FakeReleaseHostRoute>>) {
    this.routes = new Map(Object.entries(routes));
  }

  readonly fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    this.calls.push(url);
    const route = this.routes.get(url);
    if (!route) {
      throw new Error(`FakeReleaseHost has no route for ${url}`);
    }

    const status = route.redirectTo ? 302 : (route.status ?? 200);
    const headers = new Headers(route.headers);
    if (route.redirectTo) headers.set('location', route.redirectTo);
    return Promise.resolve(new Response(route.body ?? '', { status, headers }));
  }) as typeof fetch;

  /** Every hostname resolves to one fixed public address — no test here checks the address policy itself. */
  readonly resolveHostname = (_hostname: string): Promise<{ address: string; family: 4 | 6 }[]> =>
    Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
}
