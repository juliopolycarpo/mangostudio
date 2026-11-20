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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

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
import { removeFixtureDir } from '../../support/remove-fixture-dir';

type OpenApiDocument = {
  paths: Record<
    string,
    Record<string, { parameters?: { in: string; required?: boolean }[] } | undefined>
  >;
};

let user: UserFixture;
let restoreAuth: (() => void) | null = null;
let manager: RuntimeConnectionManager;

/**
 * Recording fakes for the two container engine CLIs the hub probes, first on
 * `PATH` for the whole file. They refuse to run (exit 127), so a sweep over the
 * real application never starts a container engine on this machine. A real
 * `podman` call leaves podman's rootless pause process (`catatonit -P`) behind,
 * which the worker's leftover-process check then sees (#2329).
 *
 * POSIX only: the shims are `#!/bin/sh` scripts, which Windows cannot run.
 */
let engineShimDirectory = '';
let engineCallsFile = '';
let pathBeforeShims: string | undefined;

beforeAll(async () => {
  if (process.platform === 'win32') return;
  engineShimDirectory = await mkdtemp(join(tmpdir(), 'local-unavailable-guard-engines-'));
  engineCallsFile = join(engineShimDirectory, 'engine-calls.log');
  for (const engine of ['docker', 'podman']) {
    const shim = join(engineShimDirectory, engine);
    await writeFile(shim, `#!/bin/sh\necho "${engine} $*" >> '${engineCallsFile}'\nexit 127\n`);
    await chmod(shim, 0o755);
  }
  pathBeforeShims = process.env.PATH;
  process.env.PATH = `${engineShimDirectory}${delimiter}${pathBeforeShims ?? ''}`;
});

afterAll(async () => {
  if (!engineShimDirectory) return;
  if (pathBeforeShims === undefined) delete process.env.PATH;
  else process.env.PATH = pathBeforeShims;
  await removeFixtureDir({ role: 'local-unavailable-guard', path: engineShimDirectory });
});

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

/**
 * Routes that probe this machine's own container engines and never reach Local.
 * `GET /api/environments/containers` runs `docker version` and `podman version`
 * on the host, and the first rootless `podman` call of a user starts podman's
 * pause process (`catatonit -P`), which outlives the test worker (#2329). That
 * route has no Local dependency to guard here; its own tests inject a fake run.
 */
const PROBES_HOST_CONTAINER_ENGINES: ReadonlySet<string> = new Set([
  '/api/environments/containers',
]);

async function parameterlessGetPaths(): Promise<string[]> {
  const response = await app.handle(new Request('http://localhost/scalar/json'));
  const document = (await response.json()) as OpenApiDocument;
  return Object.entries(document.paths)
    .filter(([path, operations]) => {
      const get = operations.get;
      if (
        !get ||
        path.includes('{') ||
        FAILS_WITHOUT_LOCAL_TOO.has(path) ||
        PROBES_HOST_CONTAINER_ENGINES.has(path)
      ) {
        return false;
      }
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

  it('answers every 503 with ENVIRONMENT_UNAVAILABLE, a reason and no internal detail', async () => {
    const { restore } = createAuthenticatedApiTestApp(user);
    restoreAuth = restore;

    const paths = await parameterlessGetPaths();
    const failures: string[] = [];
    let unavailableAnswers = 0;
    for (const path of paths) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      if (response.status !== 503) continue;
      unavailableAnswers += 1;
      const text = await response.text();
      const body = JSON.parse(text) as { code?: string; details?: { reason?: string } };
      if (
        body.code !== 'ENVIRONMENT_UNAVAILABLE' ||
        typeof body.details?.reason !== 'string' ||
        /\/home\/|\.sock|\bpid\b|\n|\bat \w+ \(/.test(text)
      ) {
        failures.push(`GET ${path} -> 503 ${text}`);
      }
    }

    expect(
      unavailableAnswers,
      '(Local unavailable): expected the OpenAPI inventory to include routes that answer 503'
    ).toBeGreaterThan(3);
    expect(
      failures,
      `(Local unavailable): expected every 503 to be {code: ENVIRONMENT_UNAVAILABLE, details.reason} without a path, pid or stack | received: ${failures.join(' ; ')}`
    ).toEqual([]);
  });

  // Keep this test last: it reads what the sweeps above recorded. Reading the
  // calls of the whole file, not of one sweep of its own, is deliberate: the
  // container detection answer is cached for a few seconds, so a later sweep
  // can be served without a spawn even when an earlier one started the CLI.
  it.skipIf(process.platform === 'win32')(
    'starts no container engine CLI on the host',
    async () => {
      const calls = (await readFile(engineCallsFile, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean);
      expect(
        calls,
        `(host container engine): expected the GET sweeps to run no docker or podman command | received: ${calls.join(' ; ')}`
      ).toEqual([]);
    }
  );
});
