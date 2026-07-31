/**
 * The guard around user-supplied outbound URLs.
 *
 * No test here touches the network: `fetch` and the hostname resolver are both
 * injected, which is what lets the real address policy be exercised against a
 * table of ranges instead of against whatever DNS happens to answer.
 */

import { describe, expect, it } from 'bun:test';
import { SafeFetchError, safeFetchBytes } from '../../../src/lib/safe-fetch';

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 as const };

/** Every hostname resolves publicly unless the table below says otherwise. */
function resolverFor(table: Record<string, { address: string; family: 4 | 6 }>) {
  return (hostname: string) => Promise.resolve([table[hostname] ?? PUBLIC_ADDRESS]);
}

const publicResolver = resolverFor({});

function respondWith(...responses: Response[]) {
  const calls: string[] = [];
  const queue = [...responses];
  const fetchImpl = ((input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    const next = queue.shift();
    if (!next) throw new Error('Unexpected fetch.');
    return Promise.resolve(next);
  }) as unknown as typeof fetch;

  return { calls, fetch: fetchImpl };
}

const limits = { maxBytes: 1024, maxRedirects: 3 };

describe('safeFetchBytes', () => {
  it('returns the bytes, advertised type, and resolved URL', async () => {
    const stub = respondWith(
      new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })
    );

    const result = await safeFetchBytes('https://example.test/file', limits, {
      fetch: stub.fetch,
      resolveHostname: publicResolver,
    });

    expect(new TextDecoder().decode(result.bytes)).toBe('hello');
    expect(result.contentType).toBe('text/plain');
    expect(result.url).toBe('https://example.test/file');
  });

  it('refuses anything that is not HTTPS before making a request', async () => {
    const stub = respondWith(new Response('nope'));

    for (const url of ['http://example.test/file', 'file:///etc/passwd', 'not-a-url']) {
      await expect(
        safeFetchBytes(url, limits, { fetch: stub.fetch, resolveHostname: publicResolver })
      ).rejects.toBeInstanceOf(SafeFetchError);
    }
    expect(stub.calls).toEqual([]);
  });

  describe('address policy', () => {
    // The ranges a server must never be talked into reaching. Each is named by
    // the thing it protects, because a bare CIDR is easy to drop from the list.
    const blocked = [
      { label: 'loopback', address: '127.0.0.1', family: 4 as const },
      { label: 'RFC1918 /8', address: '10.1.2.3', family: 4 as const },
      { label: 'RFC1918 /12', address: '172.16.9.9', family: 4 as const },
      { label: 'RFC1918 /16', address: '192.168.1.1', family: 4 as const },
      { label: 'cloud metadata', address: '169.254.169.254', family: 4 as const },
      { label: 'IPv6 loopback', address: '::1', family: 6 as const },
      { label: 'IPv6 unique local', address: 'fd00::1', family: 6 as const },
      { label: 'IPv6 link local', address: 'fe80::1', family: 6 as const },
    ];

    for (const range of blocked) {
      it(`refuses a host resolving into ${range.label}`, async () => {
        const stub = respondWith(new Response('secret'));

        await expect(
          safeFetchBytes('https://internal.test/file', limits, {
            fetch: stub.fetch,
            resolveHostname: resolverFor({ 'internal.test': range }),
          })
        ).rejects.toThrow('refused');
        // Nothing internal is contacted: the policy runs before the request.
        expect(stub.calls).toEqual([]);
      });
    }
  });

  it('re-checks the address policy on every redirect hop', async () => {
    const stub = respondWith(
      new Response(null, { status: 302, headers: { location: 'https://internal.test/file' } })
    );

    await expect(
      safeFetchBytes('https://example.test/file', limits, {
        fetch: stub.fetch,
        resolveHostname: resolverFor({
          'internal.test': { address: '169.254.169.254', family: 4 },
        }),
      })
    ).rejects.toThrow('refused');
    expect(stub.calls).toEqual(['https://example.test/file']);
  });

  it('refuses a redirect that downgrades to plain HTTP', async () => {
    const stub = respondWith(
      new Response(null, { status: 302, headers: { location: 'http://example.test/file' } })
    );

    await expect(
      safeFetchBytes('https://example.test/file', limits, {
        fetch: stub.fetch,
        resolveHostname: publicResolver,
      })
    ).rejects.toThrow('non-HTTPS');
    expect(stub.calls).toEqual(['https://example.test/file']);
  });

  it('follows redirects up to the limit and then stops', async () => {
    const redirect = () =>
      new Response(null, { status: 302, headers: { location: 'https://example.test/next' } });
    const stub = respondWith(redirect(), redirect(), redirect(), redirect(), redirect());

    await expect(
      safeFetchBytes(
        'https://example.test/file',
        { maxBytes: 1024, maxRedirects: 2 },
        {
          fetch: stub.fetch,
          resolveHostname: publicResolver,
        }
      )
    ).rejects.toThrow('redirect limit');
    // The initial request plus two permitted hops.
    expect(stub.calls).toHaveLength(3);
  });

  it('refuses an oversized body declared by content-length', async () => {
    const stub = respondWith(new Response('x'.repeat(64), { headers: { 'content-length': '64' } }));

    await expect(
      safeFetchBytes(
        'https://example.test/file',
        { maxBytes: 32, maxRedirects: 0 },
        {
          fetch: stub.fetch,
          resolveHostname: publicResolver,
        }
      )
    ).rejects.toThrow('exceeds');
  });

  it('refuses an oversized body that lies about its length', async () => {
    // A hostile server can understate content-length or omit it entirely, so
    // the cap has to hold while the body streams rather than before it starts.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let chunk = 0; chunk < 8; chunk += 1) {
          controller.enqueue(new Uint8Array(16));
        }
        controller.close();
      },
    });
    const stub = respondWith(new Response(body, { headers: { 'content-length': '1' } }));

    await expect(
      safeFetchBytes(
        'https://example.test/file',
        { maxBytes: 32, maxRedirects: 0 },
        {
          fetch: stub.fetch,
          resolveHostname: publicResolver,
        }
      )
    ).rejects.toThrow('exceeds');
  });

  it('reports a failed status without leaking the body', async () => {
    const stub = respondWith(new Response('internal service banner', { status: 403 }));

    await expect(
      safeFetchBytes('https://example.test/file', limits, {
        fetch: stub.fetch,
        resolveHostname: publicResolver,
      })
    ).rejects.toThrow('HTTP 403');
  });

  it('gives up on a request that outlives its deadline', async () => {
    const stub = {
      fetch: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    };

    await expect(
      safeFetchBytes(
        'https://example.test/file',
        { ...limits, timeoutMs: 20 },
        { fetch: stub.fetch, resolveHostname: publicResolver }
      )
    ).rejects.toThrow('timed out');
  });

  it("calls a caller's own abort a cancellation rather than a timeout", async () => {
    // Both arrive as one combined signal, and a caller that stopped the request
    // itself should not be told the far end was slow.
    const controller = new AbortController();
    const stub = {
      // Aborts before the call and aborts during it both have to reject, the
      // way a real `fetch` does — the address policy is awaited first, so which
      // of the two happens here is a matter of scheduling.
      fetch: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    };

    const pending = safeFetchBytes(
      'https://example.test/file',
      { ...limits, timeoutMs: 60_000, signal: controller.signal },
      { fetch: stub.fetch, resolveHostname: publicResolver }
    );
    controller.abort();

    await expect(pending).rejects.toThrow('cancelled');
  });
});
