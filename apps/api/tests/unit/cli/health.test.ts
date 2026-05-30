import { afterEach, describe, expect, it } from 'bun:test';
import { probeHealth } from '../../../src/cli/health';

const realFetch = globalThis.fetch;

/** Replace global fetch with a fixed response for one assertion. */
function stubFetch(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (() => Promise.resolve(respond())) as unknown as typeof fetch;
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
});
