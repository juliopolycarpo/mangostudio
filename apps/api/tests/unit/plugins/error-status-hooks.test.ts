/**
 * What a hook sees as the response status after an error handler answered.
 *
 * The error arms return `status(code, body)` and never assign `set.status`
 * themselves, so a handler that had already set `set.status = 201` before it
 * threw could, in principle, leave a later `mapResponse` or `afterResponse`
 * hook reading 201 for a response that goes out as 500. Elysia currently copies
 * an `ElysiaStatus` result onto `set.status` before those hooks run; this suite
 * fails if an upgrade stops doing that, or if an arm is rewritten to answer in a
 * way that bypasses it.
 *
 * The supported way to read the status in a hook is `resolveStatus`, which
 * prefers the `ElysiaStatus` the handler returned over `set.status`. Both are
 * asserted to agree with the wire status, so a hook that reads `set.status`
 * directly is not silently relying on luck either.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Elysia, t } from 'elysia';

import { EnvironmentUnavailableError } from '../../../src/lib/environment-unavailable';
import { errorHandler } from '../../../src/plugins/error-handler';
import { resolveStatus } from '../../../src/plugins/error-negotiation';

interface ObservedStatus {
  readonly hook: 'mapResponse' | 'afterResponse';
  /** What `set.status` held when the hook ran. */
  readonly setStatus: number | string | undefined;
  /** What `resolveStatus` returned for the same hook call. */
  readonly resolved: number | null;
}

/** Quiet the handler's own diagnostics; they are not under test here. */
let restoreConsoleError: (() => void) | null = null;

beforeEach(() => {
  const original = console.error;
  console.error = () => {};
  restoreConsoleError = () => {
    console.error = original;
  };
});

afterEach(() => {
  restoreConsoleError?.();
  restoreConsoleError = null;
});

/**
 * Every route sets a success status first, then fails: the stale-value case.
 * The observer hooks record what they read; `afterResponse` runs after the
 * response is built, so its record is awaited through `settled`.
 */
function buildApp() {
  const observed: ObservedStatus[] = [];
  let markAfterResponseSeen: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    markAfterResponseSeen = resolve;
  });

  const app = new Elysia()
    .use(errorHandler)
    .mapResponse('global', ({ set, responseValue }) => {
      observed.push({
        hook: 'mapResponse',
        setStatus: set.status,
        resolved: resolveStatus(responseValue, set),
      });
    })
    .onAfterResponse('global', ({ set, responseValue }) => {
      observed.push({
        hook: 'afterResponse',
        setStatus: set.status,
        resolved: resolveStatus(responseValue, set),
      });
      markAfterResponseSeen();
    })
    .get('/throws', ({ set }) => {
      set.status = 201;
      throw new Error('handler failed after choosing a success status');
    })
    .get('/unavailable', ({ set }) => {
      set.status = 201;
      throw new EnvironmentUnavailableError('backing-off', 'local is backing off', {
        retryAfterSeconds: 4,
      });
    })
    .get('/invalid-response', { response: { 201: t.Object({ name: t.String() }) } }, ({ set }) => {
      set.status = 201;
      return { name: 42 } as never;
    });

  return { app, observed, settled };
}

describe('status seen by hooks after an error handler answers', () => {
  it.each([
    ['an unexpected throw', '/throws', 500],
    ['an environment that cannot be reached', '/unavailable', 503],
    ['a response that fails its own schema', '/invalid-response', 500],
  ] as const)(
    'answers %s with %i, and mapResponse and afterResponse read the same status',
    async (_label, path, expectedStatus) => {
      const { app, observed, settled } = buildApp();

      const response = await app.handle(new Request(`http://localhost${path}`));
      await settled;

      expect(response.status, `(${path}): wire status after set.status = 201`).toBe(expectedStatus);
      // A response that fails validation reaches `mapResponse` once as the
      // handler's 201 before the error arm replaces it, so judge the last
      // call of each hook: that is the one describing what goes on the wire.
      for (const hook of ['mapResponse', 'afterResponse'] as const) {
        const last = observed.filter((entry) => entry.hook === hook).at(-1);
        expect(
          last,
          `(${path} ${hook}): hook did not run; saw ${JSON.stringify(observed)}`
        ).toBeDefined();
        expect(last?.resolved, `(${path} ${hook}): resolveStatus`).toBe(expectedStatus);
        expect(
          last?.setStatus,
          `(${path} ${hook}): set.status held ${String(last?.setStatus)}, expected ${expectedStatus}`
        ).toBe(expectedStatus);
      }
    }
  );
});
