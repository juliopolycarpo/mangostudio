/**
 * A route added later cannot silently turn an unavailable Local into a 500.
 *
 * The candidate list comes from the real application's OpenAPI inventory rather
 * than a hand-kept list: every `GET` route with no path or required query
 * parameter is requested with a Local connector that refuses, and none may
 * answer 5xx other than the one 503 this mapping owns.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DEFAULT_LIBRARY_LOCATION_SETTINGS } from '@mangostudio/shared/app-settings';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';

import { app } from '../../../src/app';
import { EnvironmentUnavailableError } from '../../../src/lib/environment-unavailable';
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
        Promise.reject(new EnvironmentUnavailableError('binary-missing', 'no runtime binary')),
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
 * The API key listing calls the auth plugin with the request's real session
 * headers, which the mocked session cannot supply, so it fails with or without
 * an environment.
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
