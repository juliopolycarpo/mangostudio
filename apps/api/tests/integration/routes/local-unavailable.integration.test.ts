import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { ApiErrorResponseSchema } from '@mangostudio/shared/errors';
import Value from 'typebox/value';

import { sseResponse } from '../../../src/lib/sse-stream';
import { environmentRoutes } from '../../../src/modules/environments/http/environment-routes';
import { libraryRoutes } from '../../../src/modules/library/http/library-routes';
import { librarySettingsRoutes } from '../../../src/modules/library/http/settings-routes';
import { errorHandler } from '../../../src/plugins/error-handler';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'local-unavailable-user',
  name: 'Local Unavailable User',
  email: 'local-unavailable@mangostudio.test',
};

const MISSING_BINARY_MESSAGE =
  'The mangostudio-runtime binary was not found; build it with `bun run build:runtime`.';

/**
 * A Local connector that fails the way a missing `mangostudio-runtime` does:
 * `UNAVAILABLE` with the reason the connection manager keeps for the UI.
 */
function refuseLocalConnect(): Promise<never> {
  return Promise.reject(new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, MISSING_BINARY_MESSAGE));
}

/** Every GET route whose handler asks the Local environment for something. */
const LOCAL_REACHING_ROUTES = [
  '/library/resources',
  '/library/settings',
  '/library/settings/compare',
  '/library/settings/claude',
  '/environments/runtimes',
  '/environments/runtimes/node',
  '/environments/version-managers',
  '/environments/version-managers/nvm',
  '/environments/agents',
  '/environments/agents/claude',
] as const;

let restoreAuth: (() => void) | null = null;
let manager: RuntimeConnectionManager;

beforeEach(() => {
  manager = new RuntimeConnectionManager({
    resolveEnvironment: (userId) =>
      Promise.resolve({
        id: LOCAL_ENVIRONMENT_ID,
        userId,
        name: 'Local',
        transportKind: 'in-process' as const,
        config: {},
        enabled: true,
      }),
    connectors: { 'in-process': refuseLocalConnect },
  });
  setRuntimeConnectionManagerForTests(manager);
});

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await manager.closeAll();
  setRuntimeConnectionManagerForTests(undefined);
});

describe('unavailable Local environment', () => {
  it.each(LOCAL_REACHING_ROUTES)(
    'GET %s answers 503 PROVIDER_ERROR with the reason',
    async (path) => {
      const { app, restore } = createAuthenticatedApiTestApp(
        TEST_USER,
        errorHandler,
        environmentRoutes,
        libraryRoutes,
        librarySettingsRoutes
      );
      restoreAuth = restore;

      const response = await app.handle(new Request(`http://localhost${path}`));
      const text = await response.text();
      const received = `GET ${path} -> ${response.status} ${text}`;

      expect(
        response.status,
        `(${path}): expected status 503 for an unavailable Local | received: ${received}`
      ).toBe(503);
      const body: unknown = JSON.parse(text);
      expect(
        Value.Check(ApiErrorResponseSchema, body),
        `(${path}): expected an ApiErrorResponse body | received: ${text}`
      ).toBe(true);
      expect(
        body,
        `(${path}): expected code PROVIDER_ERROR and the connect failure | received: ${text}`
      ).toMatchObject({
        code: 'PROVIDER_ERROR',
        error: MISSING_BINARY_MESSAGE,
      });
    }
  );
});

describe('unavailable Local environment on a retry inside the backoff window', () => {
  it('answers 503 with Retry-After once the connection manager has scheduled the next attempt', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      errorHandler,
      environmentRoutes
    );
    restoreAuth = restore;

    await app.handle(new Request('http://localhost/environments/runtimes'));
    const retried = await app.handle(new Request('http://localhost/environments/runtimes'));
    const text = await retried.text();

    expect(
      retried.status,
      `(/environments/runtimes retry): expected 503 | received: ${retried.status} ${text}`
    ).toBe(503);
    expect(
      Number(retried.headers.get('retry-after')),
      `(/environments/runtimes retry): expected Retry-After to be a positive number of seconds | received: ${retried.headers.get('retry-after')}`
    ).toBeGreaterThan(0);
    expect(JSON.parse(text)).toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

/** A progress source whose first read reaches an environment that cannot be reached. */
async function* unreachableEnvironmentProgress(): AsyncGenerator<object> {
  await Promise.resolve();
  throw new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, MISSING_BINARY_MESSAGE);
}

describe('unavailable environment on an SSE stream', () => {
  it('ends with one SSEErrorEvent carrying PROVIDER_ERROR and the reason', async () => {
    const response = sseResponse(unreachableEnvironmentProgress(), 'Stream failed.');
    const text = await response.text();
    const frames = text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice('data: '.length)) as unknown);

    expect(
      frames,
      `(sse): expected one error event {type:'error', code:'PROVIDER_ERROR', done:true} | received: ${text}`
    ).toEqual([
      { type: 'error', error: MISSING_BINARY_MESSAGE, code: 'PROVIDER_ERROR', done: true },
    ]);
  });
});
