import { afterEach, describe, expect, it } from 'bun:test';

import { Elysia } from 'elysia';

import { HUB_IDLE_TIMEOUT_SECONDS, hubListenOptions } from '../../../src/lib/hub-connection-limits';
import { createExternalAgentRoutes } from '../../../src/modules/external-agents/http/external-agent-routes';
import { createExternalSessionRoutes } from '../../../src/modules/external-agents/http/external-session-routes';
import { handlerIdleTimeout } from '../../../src/plugins/handler-idle-timeout';
import { insertTestUser } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { withFakeTargetHome } from '../../unit/services/tools/support/target-home';

// Bun resets a request that has sent no bytes for the listener's idle timeout
// (10 s on the hub), and its idle check is coarse: the reset lands about 12 s
// in. A handler that is merely slow must still answer, so every slow dependency
// below holds its reply for 14 s: past the reset, short of any deadline these
// routes carry. All three are requests without a body, the shape Bun resets,
// and none declares anything about timeouts: `handlerIdleTimeout`, mounted first
// the way `app.ts` mounts it, covers every route behind it.
const SLOW_DEPENDENCY_MS = 14_000;

let restoreAuth: (() => void) | null = null;
let stopServer: (() => Promise<void>) | null = null;

afterEach(async () => {
  await stopServer?.();
  stopServer = null;
  restoreAuth?.();
  restoreAuth = null;
});

/** Named fake for the native-session service: a vendor history listing that takes its time. */
class SlowNativeSessionService {
  async list() {
    await Bun.sleep(SLOW_DEPENDENCY_MS);
    return { ok: true as const, sessions: [] };
  }

  adopt(): never {
    throw new Error('SlowNativeSessionService.adopt: the route under test never adopts');
  }
}

/** Named fake for agent discovery: an environment probe that takes its time. */
class SlowAgentDiscovery {
  async describeExternalAgents() {
    await Bun.sleep(SLOW_DEPENDENCY_MS);
    return [];
  }
}

interface RouteOutcome {
  route: string;
  status: number | string;
}

async function requestThroughListener(
  baseUrl: URL,
  method: 'GET' | 'POST',
  route: string
): Promise<RouteOutcome> {
  try {
    const response = await fetch(new URL(route, baseUrl), { method });
    await response.arrayBuffer();
    return { route: `${method} ${route}`, status: response.status };
  } catch (error) {
    return {
      route: `${method} ${route}`,
      status: `error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

describe('slow handlers behind the hub listener options', () => {
  it(
    'answer when the dependency is silent past the idle timeout',
    async () => {
      expect(SLOW_DEPENDENCY_MS).toBeGreaterThan(HUB_IDLE_TIMEOUT_SECONDS * 1_000 + 2_000);
      const user = await insertTestUser();
      const authenticated = createAuthenticatedApiTestApp(
        user,
        handlerIdleTimeout,
        createExternalAgentRoutes({ discovery: new SlowAgentDiscovery() }),
        createExternalSessionRoutes(new SlowNativeSessionService())
      );
      restoreAuth = authenticated.restore;
      const listening = authenticated.app.listen(hubListenOptions('127.0.0.1', 0));
      stopServer = async () => {
        await authenticated.app.stop(true);
      };
      const baseUrl = new URL(`http://127.0.0.1:${listening.server?.port}`);

      const outcomes = await withFakeTargetHome(
        '/target/home',
        {
          // The runtime's refresh call is the slow dependency behind the
          // account-limits route.
          'external-agent.refresh-account-usage': async () => {
            await Bun.sleep(SLOW_DEPENDENCY_MS);
            return {};
          },
        },
        // All routes run at once, so the test pays the silent gap one time.
        () =>
          Promise.all([
            requestThroughListener(
              baseUrl,
              'POST',
              '/external-agents/codex/account-limits/refresh'
            ),
            requestThroughListener(baseUrl, 'GET', '/external-agents/sessions?targetId=codex'),
            requestThroughListener(baseUrl, 'GET', '/external-agents'),
          ])
      );

      expect(outcomes).toEqual([
        { route: 'POST /external-agents/codex/account-limits/refresh', status: 200 },
        { route: 'GET /external-agents/sessions?targetId=codex', status: 200 },
        { route: 'GET /external-agents', status: 200 },
      ]);
    },
    // The gap itself plus headroom for a loaded runner.
    SLOW_DEPENDENCY_MS + 8_000
  );

  it(
    'still closes a parse: none route whose declared body never arrives',
    async () => {
      // The shape of the Better Auth passthrough: Elysia does not read the body,
      // the handler does, after `beforeHandle`. A client that sends the headers
      // of a POST with a body and then nothing must hit the listener's timeout,
      // not the 255 s a running handler gets.
      const app = new Elysia()
        .use(handlerIdleTimeout)
        .post('/raw-body', { parse: 'none' }, ({ request }) => request.text());
      const listening = app.listen(hubListenOptions('127.0.0.1', 0));
      stopServer = async () => {
        await app.stop(true);
      };

      const startedAt = Date.now();
      let closedAfterMs: number | null = null;
      const closed = new Promise<void>((resolve) => {
        void Bun.connect({
          hostname: '127.0.0.1',
          port: listening.server?.port ?? 0,
          socket: {
            open(socket) {
              socket.write(
                'POST /raw-body HTTP/1.1\r\nHost: hub.test\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n'
              );
            },
            data() {},
            close() {
              closedAfterMs = Date.now() - startedAt;
              resolve();
            },
            error() {},
          },
        });
      });
      // Bun's idle check lands about 12 s in; 16 s is the bound, not the target.
      const closeBoundMs = 16_000;
      await Promise.race([closed, Bun.sleep(closeBoundMs)]);

      expect(
        closedAfterMs,
        `(slow-route-idle-timeout): expected the connection to close within ${closeBoundMs}ms of a declared body that never arrived | received: ${closedAfterMs === null ? `still open after ${closeBoundMs}ms` : `closed after ${closedAfterMs}ms`}`
      ).not.toBeNull();
    },
    16_000 + 8_000
  );
});
