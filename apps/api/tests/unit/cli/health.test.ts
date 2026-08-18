import { afterEach, describe, expect, it } from 'bun:test';
import { probeHealth } from '../../../src/cli/health';
import { ADDRESS_FIXTURES } from '../lib/ip-address.fixtures';

const realFetch = globalThis.fetch;

/** Replace global fetch with a fixed response for one assertion. */
function stubFetch(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (() => Promise.resolve(respond())) as unknown as typeof fetch;
}

/** Records every fetch target so we can assert which host was (not) reached. */
function recordingFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
  }) as unknown as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('probeHealth', () => {
  it('returns true on 200 {status:"ok"}', async () => {
    stubFetch(() => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    expect(await probeHealth('localhost', 3001)).toBe(true);
  });

  it('returns false on a non-2xx status', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    expect(await probeHealth('localhost', 3001)).toBe(false);
  });

  it('returns false when the body status is not ok', async () => {
    stubFetch(() => new Response(JSON.stringify({ status: 'degraded' }), { status: 200 }));
    expect(await probeHealth('localhost', 3001)).toBe(false);
  });

  it('returns false when the request throws', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('refused'))) as unknown as typeof fetch;
    expect(await probeHealth('localhost', 3001)).toBe(false);
  });

  it.each([
    ['localhost', 'http://localhost:3001/api/health'],
    ['127.0.0.1', 'http://127.0.0.1:3001/api/health'],
    ['127.0.0.2', 'http://127.0.0.2:3001/api/health'],
    ['0.0.0.0', 'http://127.0.0.1:3001/api/health'],
    ['::1', 'http://[::1]:3001/api/health'],
    ['::', 'http://[::1]:3001/api/health'],
  ])('probes the loopback target for local host %s', async (host, expectedUrl) => {
    const { calls } = recordingFetch();
    expect(await probeHealth(host, 3001)).toBe(true);
    expect(calls).toEqual([expectedUrl]);
  });

  it.each(['evil.test', '169.254.169.254', '10.0.0.1', '192.168.1.5', 'example.com'])(
    'fails closed without issuing a request for non-local host %s',
    async (host) => {
      const { calls } = recordingFetch();
      expect(await probeHealth(host, 3001)).toBe(false);
      expect(calls).toEqual([]);
    }
  );

  it.each(ADDRESS_FIXTURES)(
    'probes only the loopback addresses in the shared table: $input',
    async ({ input, loopback }) => {
      const { calls } = recordingFetch();
      expect(await probeHealth(input, 3001)).toBe(loopback);
      expect(calls.length).toBe(loopback ? 1 : 0);
      // Asserting the count alone would pass on an unbracketed IPv6 target:
      // `http://::1:3001/api/health` still reaches the stub. Parse it instead, so
      // dropping the bracketing fails here rather than at a real fetch.
      for (const call of calls) expect(() => new URL(call)).not.toThrow();
    }
  );

  it('brackets an IPv6 loopback carrying a zone id', async () => {
    // API_HOST reaches cfg.server.host unvalidated, so `::1%lo0` is reachable —
    // and `new URL('http://[::1%lo0]:3001/…')` throws, so the zone id has to come
    // off rather than be re-bracketed with the address.
    const { calls } = recordingFetch();
    expect(await probeHealth('::1%lo0', 3001)).toBe(true);
    expect(calls).toEqual(['http://[::1]:3001/api/health']);
  });
});
