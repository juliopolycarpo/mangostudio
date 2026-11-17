/**
 * A route added later cannot silently turn an unavailable Local into a 500.
 *
 * The candidate list comes from the real application's OpenAPI inventory rather
 * than a hand-kept list: every `GET` route with no path or required query
 * parameter is requested with a Local connector that refuses, and none may
 * answer 5xx other than the one 503 this mapping owns.
 *
 * Not covered: routes with a path parameter (`{id}` and the like), routes with a
 * required query parameter, non-GET methods, and routes hidden from OpenAPI.
 * Those stay with the explicit table in `local-unavailable.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import { DEFAULT_LIBRARY_LOCATION_SETTINGS } from '@mangostudio/shared/app-settings';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';

import { app } from '../../../src/app';
import { setLibraryLocationDefaultsForTest } from '../../../src/modules/app-settings/application/app-settings-service';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { insertTestUser, type UserFixture } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

type OpenApiDocument = {
  paths: Record<
    string,
    Record<string, { parameters?: { in: string; required?: boolean }[] } | undefined>
  >;
};

let user: UserFixture;
let restoreAuth: (() => void) | null = null;
let manager: RuntimeConnectionManager;

beforeEach(async () => {
  setLibraryLocationDefaultsForTest(null);
  user = await insertTestUser();
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
    connectors: {
      'in-process': () =>
        // What the real Local connector throws: a plain RemoteError carrying the
        // launch reason, which the manager must wrap into the mapped class.
        Promise.reject(
          new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'no runtime binary', {
            localFailureReason: 'binary-missing',
          })
        ),
    },
  });
  setRuntimeConnectionManagerForTests(manager);
});

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  setLibraryLocationDefaultsForTest(DEFAULT_LIBRARY_LOCATION_SETTINGS);
  await manager.closeAll();
  setRuntimeConnectionManagerForTests(undefined);
});

/**
 * Routes that answer 500 under this harness for a reason unrelated to Local.
 * Checked by removing this exclusion: `GET /api/api-keys/` answered
 * `500 {"error":"Unexpected API key management error.","code":"INTERNAL"}` with
 * no connector installed at all, so it is the mocked session, not Local.
 */
const FAILS_WITHOUT_LOCAL_TOO: ReadonlySet<string> = new Set(['/api/api-keys/']);

async function parameterlessGetPaths(): Promise<string[]> {
  const response = await app.handle(new Request('http://localhost/scalar/json'));
  const document = (await response.json()) as OpenApiDocument;
  return Object.entries(document.paths)
    .filter(([path, operations]) => {
      const get = operations.get;
      if (!get || path.includes('{') || FAILS_WITHOUT_LOCAL_TOO.has(path)) return false;
      return !(get.parameters ?? []).some((parameter) => parameter.required === true);
    })
    .map(([path]) => path)
    .sort();
}

describe('every parameterless GET route with Local unavailable', () => {
  it('reports the launch reason a plain connector failure carried', async () => {
    const { restore } = createAuthenticatedApiTestApp(user);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/api/skills'));
    const body = (await response.json()) as { details?: { reason?: string } };

    expect(
      { status: response.status, reason: body.details?.reason },
      '(GET /api/skills): expected 503 with details.reason binary-missing'
    ).toEqual({ status: 503, reason: 'binary-missing' });
  });

  it('never answers 500', async () => {
    const { restore } = createAuthenticatedApiTestApp(user);
    restoreAuth = restore;

    const paths = await parameterlessGetPaths();
    expect(paths.length, 'expected the OpenAPI inventory to list GET routes').toBeGreaterThan(20);

    const failures: string[] = [];
    for (const path of paths) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      if (response.status >= 500 && response.status !== 503) {
        failures.push(`GET ${path} -> ${response.status} ${await response.text()}`);
      }
    }

    expect(
      failures,
      `(Local unavailable): expected no GET route to answer 5xx other than 503 | received: ${failures.join(' ; ')}`
    ).toEqual([]);
  });
});
