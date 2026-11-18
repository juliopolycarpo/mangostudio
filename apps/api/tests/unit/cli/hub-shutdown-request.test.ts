import { describe, expect, it } from 'bun:test';

import { requestHubShutdown } from '../../../src/cli/hub-shutdown-request';
import { HUB_CONTROL_TOKEN_HEADER, HUB_SHUTDOWN_PATH } from '../../../src/lib/hub-control';
import type { ServerState } from '../../../src/lib/server-state';

const STATE: ServerState = {
  pid: 42,
  port: 3001,
  host: '127.0.0.1',
  startedAt: 0,
  logFile: '',
  version: 't',
  controlToken: 'token-from-the-state-file',
};

interface RecordedCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly token: string | null;
}

/** A `fetch` that records what it was asked and answers with `respond`. */
class FakeFetch {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly respond: () => Response | Error) {}

  readonly fetch = ((input: string | URL | Request, init?: RequestInit) => {
    this.calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method,
      token: new Headers(init?.headers).get(HUB_CONTROL_TOKEN_HEADER),
    });
    const answer = this.respond();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }) as typeof fetch;
}

describe('requestHubShutdown', () => {
  it('posts the control token to the hub on loopback and reports an accepted request', async () => {
    const http = new FakeFetch(() => new Response('{"status":"stopping"}', { status: 202 }));

    const answer = await requestHubShutdown(STATE, { fetch: http.fetch });

    expect(answer).toEqual({ accepted: true });
    expect(http.calls).toEqual([
      {
        url: `http://127.0.0.1:3001${HUB_SHUTDOWN_PATH}`,
        method: 'POST',
        token: 'token-from-the-state-file',
      },
    ]);
  });

  it('dials loopback for a hub bound to every interface', async () => {
    const http = new FakeFetch(() => new Response(null, { status: 202 }));

    await requestHubShutdown({ ...STATE, host: '0.0.0.0' }, { fetch: http.fetch });

    expect(http.calls.map((call) => call.url)).toEqual([
      `http://127.0.0.1:3001${HUB_SHUTDOWN_PATH}`,
    ]);
  });

  it('does not dial when the state file has no control token', async () => {
    const http = new FakeFetch(() => new Response(null, { status: 202 }));
    const { controlToken: _absent, ...older } = STATE;

    const answer = await requestHubShutdown(older, { fetch: http.fetch });

    expect(answer).toEqual({ accepted: false, reason: 'this hub did not record a control token' });
    expect(http.calls, 'expected no request without a token to send').toEqual([]);
  });

  it('never sends the token to a host that is not loopback', async () => {
    const http = new FakeFetch(() => new Response(null, { status: 202 }));

    const answer = await requestHubShutdown(
      { ...STATE, host: '192.168.1.20' },
      { fetch: http.fetch }
    );

    expect(answer.accepted).toBe(false);
    expect(http.calls, 'expected no request to a non-loopback state-file host').toEqual([]);
  });

  for (const port of [0, -1, 65_536, 3001.5, Number.NaN, 1e21]) {
    it(`does not dial a state file port of ${port}`, async () => {
      const http = new FakeFetch(() => new Response(null, { status: 202 }));

      const answer = await requestHubShutdown({ ...STATE, port }, { fetch: http.fetch });

      expect(answer.accepted).toBe(false);
      expect(http.calls, `expected no request to port ${port}`).toEqual([]);
    });
  }

  it('reports the status when the hub refuses the token', async () => {
    const http = new FakeFetch(() => new Response('{}', { status: 401 }));

    const answer = await requestHubShutdown(STATE, { fetch: http.fetch });

    expect(answer).toEqual({ accepted: false, reason: 'the hub answered HTTP 401' });
  });

  it('reports a connection failure instead of throwing', async () => {
    const http = new FakeFetch(() => new Error('connect refused'));

    const answer = await requestHubShutdown(STATE, { fetch: http.fetch });

    expect(answer).toEqual({
      accepted: false,
      reason: 'the hub could not be reached (connect refused)',
    });
  });
});
