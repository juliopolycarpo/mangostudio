import { afterEach, describe, expect, it } from 'bun:test';

import { Elysia } from 'elysia';

import { app } from '../../../src/app';
import {
  createHubControlToken,
  currentHubControlToken,
  HUB_CONTROL_TOKEN_HEADER,
  HUB_SHUTDOWN_PATH,
  hubControlTokenMatches,
  issueHubControlToken,
  resetHubControlTokenForTest,
} from '../../../src/lib/hub-control';
import { createHubControlRoutes } from '../../../src/routes/hub-control';
import { listenOnEphemeralPort } from '../../support/listen-ephemeral';

const TOKEN = 'a-control-token-only-the-state-file-holds';

/** Builds the route with a recording shutdown and a scripted socket peer. */
function routeUnderTest(options: { token?: string; peer?: string } = {}) {
  const shutdowns: number[] = [];
  const routes = createHubControlRoutes({
    token: () => ('token' in options ? options.token : TOKEN),
    shutdown: () => shutdowns.push(Date.now()),
    peerAddress: () => options.peer ?? '127.0.0.1',
  });
  const handle = (headers: Record<string, string>) =>
    new Elysia({ prefix: '/api' })
      .use(routes)
      .handle(new Request(`http://localhost${HUB_SHUTDOWN_PATH}`, { method: 'POST', headers }));
  /** The route schedules the stop after it answers; let that timer run. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
  return { handle, shutdowns, settle };
}

describe('POST /api/control/shutdown', () => {
  it('starts the shutdown for a loopback peer that presents the token', async () => {
    const { handle, shutdowns, settle } = routeUnderTest();

    const response = await handle({ [HUB_CONTROL_TOKEN_HEADER]: TOKEN });
    await settle();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'stopping' });
    expect(shutdowns.length, 'expected exactly one shutdown after an accepted request').toBe(1);
  });

  it('answers a loopback peer with no token 401 and does not shut down', async () => {
    const { handle, shutdowns, settle } = routeUnderTest();

    const response = await handle({});
    await settle();

    expect(response.status).toBe(401);
    expect(shutdowns).toEqual([]);
  });

  it('answers a wrong token 401 and does not shut down', async () => {
    const { handle, shutdowns, settle } = routeUnderTest();

    const response = await handle({ [HUB_CONTROL_TOKEN_HEADER]: `${TOKEN}-but-wrong` });
    await settle();

    expect(response.status).toBe(401);
    expect(shutdowns).toEqual([]);
  });

  it('refuses every request while no token has been issued, even one carrying a header', async () => {
    const { handle, shutdowns, settle } = routeUnderTest({ token: undefined });

    const response = await handle({ [HUB_CONTROL_TOKEN_HEADER]: TOKEN });
    await settle();

    expect(response.status).toBe(401);
    expect(shutdowns).toEqual([]);
  });

  it('refuses a valid token from a non-loopback peer with 403', async () => {
    const { handle, shutdowns, settle } = routeUnderTest({ peer: '203.0.113.5' });

    const response = await handle({ [HUB_CONTROL_TOKEN_HEADER]: TOKEN });
    await settle();

    expect(response.status).toBe(403);
    expect(shutdowns, 'expected no shutdown for a peer at 203.0.113.5').toEqual([]);
  });

  it('refuses a valid token when the socket peer is unknown', async () => {
    const shutdowns: number[] = [];
    const routes = createHubControlRoutes({
      token: () => TOKEN,
      shutdown: () => shutdowns.push(1),
      peerAddress: () => undefined,
    });

    const response = await new Elysia({ prefix: '/api' }).use(routes).handle(
      new Request(`http://localhost${HUB_SHUTDOWN_PATH}`, {
        method: 'POST',
        headers: { [HUB_CONTROL_TOKEN_HEADER]: TOKEN },
      })
    );

    expect(response.status).toBe(403);
    expect(shutdowns).toEqual([]);
  });

  for (const proxyHeader of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip']) {
    it(`refuses a loopback peer that carries ${proxyHeader}: a reverse proxy on loopback fronts a remote caller`, async () => {
      const { handle, shutdowns, settle } = routeUnderTest();

      const response = await handle({
        [HUB_CONTROL_TOKEN_HEADER]: TOKEN,
        [proxyHeader]: '203.0.113.5',
      });
      await settle();

      expect(response.status).toBe(403);
      expect(shutdowns).toEqual([]);
    });
  }
});

describe('POST /api/control/shutdown over a real socket', () => {
  const stops: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  /** Listens on an ephemeral port with the real socket-peer lookup (no injected peer). */
  async function listen(shutdowns: number[]) {
    const server = new Elysia({ prefix: '/api' }).use(
      createHubControlRoutes({ token: () => TOKEN, shutdown: () => shutdowns.push(1) })
    );
    const port = await listenOnEphemeralPort(server);
    stops.push(() => server.stop(true));
    return `http://127.0.0.1:${port}${HUB_SHUTDOWN_PATH}`;
  }

  it('accepts the token from the loopback peer the socket reports', async () => {
    const shutdowns: number[] = [];
    const url = await listen(shutdowns);

    const response = await fetch(url, {
      method: 'POST',
      headers: { [HUB_CONTROL_TOKEN_HEADER]: TOKEN },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(response.status).toBe(202);
    expect(shutdowns.length).toBe(1);
  });

  it('refuses the same loopback request once it carries a proxy header', async () => {
    const shutdowns: number[] = [];
    const url = await listen(shutdowns);

    const response = await fetch(url, {
      method: 'POST',
      headers: { [HUB_CONTROL_TOKEN_HEADER]: TOKEN, 'x-forwarded-for': '203.0.113.5' },
    });

    expect(response.status).toBe(403);
    expect(shutdowns).toEqual([]);
  });
});

describe('the hub control route inside the application', () => {
  afterEach(resetHubControlTokenForTest);

  it('is mounted, needs no session, and refuses a caller without the token', async () => {
    issueHubControlToken();

    // `app.handle` carries no socket, so the peer is unknown and the request is refused as remote.
    const response = await app.handle(
      new Request(`http://localhost${HUB_SHUTDOWN_PATH}`, {
        method: 'POST',
        headers: { [HUB_CONTROL_TOKEN_HEADER]: currentHubControlToken() ?? '' },
      })
    );

    expect(response.status, 'expected 403 (route reached, peer not loopback), not 404 or 401').toBe(
      403
    );
  });
});

describe('hub control token', () => {
  afterEach(resetHubControlTokenForTest);

  it('mints 256-bit hex tokens that differ each time', () => {
    const first = createHubControlToken();
    const second = createHubControlToken();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it('keeps the issued token for the route and nothing before it', () => {
    expect(currentHubControlToken()).toBeUndefined();

    const issued = issueHubControlToken();

    expect(currentHubControlToken()).toBe(issued);
  });

  it('matches only the identical token', () => {
    expect(hubControlTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(hubControlTokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(hubControlTokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(hubControlTokenMatches('', TOKEN)).toBe(false);
    expect(hubControlTokenMatches(null, TOKEN)).toBe(false);
    expect(hubControlTokenMatches(TOKEN, undefined)).toBe(false);
    expect(hubControlTokenMatches(undefined, undefined)).toBe(false);
  });
});
