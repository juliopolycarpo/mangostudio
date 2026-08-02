import { afterEach, describe, expect, it } from 'bun:test';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import type {
  ConceptComparison,
  LibraryTargetId,
  SettingsSnapshot,
} from '@mangostudio/shared/library';
import type { LibraryScope } from '../../../src/modules/library/application/environment-library-service';
import {
  createSettingsRoutes,
  type SettingsRouteService,
} from '../../../src/modules/library/http/settings-routes';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'library-settings-user',
  name: 'Library Settings User',
  email: 'library-settings@mangostudio.test',
};

const snapshots: SettingsSnapshot[] = (['mangostudio', 'claude', 'codex', 'cursor'] as const).map(
  (targetId) => ({
    targetId,
    sources: [],
  })
);

const comparisons: ConceptComparison[] = [
  {
    concept: 'selected-model',
    comparability: 'rough',
    entries: [
      {
        targetId: 'codex',
        state: 'detected',
        fields: [{ path: 'model', presentation: 'value', value: 'gpt-5' }],
      },
    ],
  },
];

const scopes: LibraryScope[] = [];

const service: SettingsRouteService = {
  list: (scope) => {
    scopes.push(scope);
    return Promise.resolve(snapshots);
  },
  get: (scope, targetId: LibraryTargetId) => {
    scopes.push(scope);
    return Promise.resolve(
      snapshots.find((snapshot) => snapshot.targetId === targetId) as SettingsSnapshot
    );
  },
  compare: (scope) => {
    scopes.push(scope);
    return Promise.resolve(comparisons);
  },
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
  scopes.length = 0;
});

describe('library settings routes', () => {
  it('returns one settings snapshot per target', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createSettingsRoutes(service)
    );
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/library/settings'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshots);
  });

  it('returns one target snapshot by validated target id', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createSettingsRoutes(service)
    );
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/library/settings/codex'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshots[2]);
  });

  it('returns roughly comparable settings concepts', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createSettingsRoutes(service)
    );
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/library/settings/compare'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(comparisons);
  });

  it('reads the environment named in the query, defaulting to local', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createSettingsRoutes(service)
    );
    restoreAuth = restore;

    await app.handle(new Request('http://localhost/library/settings/compare'));
    await app.handle(
      new Request('http://localhost/library/settings/compare?environmentId=remote-a')
    );

    expect(scopes.map((scope) => scope.environmentId)).toEqual(['local', 'remote-a']);
  });

  // The settings table has to say "I cannot reach that machine" rather than
  // quietly describing the hub, so an unreachable environment is a 503 here for
  // the same reason it is on the resource routes.
  it('answers 503 when the environment cannot be reached', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createSettingsRoutes({
        ...service,
        compare: () =>
          Promise.reject(new RuntimeRemoteError('RUNTIME_UNAVAILABLE', 'Environment offline.')),
      })
    );
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/settings/compare?environmentId=remote-a')
    );

    expect(response.status).toBe(503);
  });

  it('registers only GET routes for settings inspection', () => {
    expect(
      createSettingsRoutes(service).routes.map(({ method, path }) => ({
        method,
        path,
      }))
    ).toEqual([
      { method: 'GET', path: '/library/settings' },
      { method: 'GET', path: '/library/settings/compare' },
      { method: 'GET', path: '/library/settings/:targetId' },
    ]);
  });
});
