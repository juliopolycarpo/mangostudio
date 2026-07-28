import { afterEach, describe, expect, it } from 'bun:test';
import type {
  ConceptComparison,
  LibraryTargetId,
  SettingsSnapshot,
} from '@mangostudio/shared/library';
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

const service: SettingsRouteService = {
  list: () => snapshots,
  get: (targetId: LibraryTargetId) =>
    snapshots.find((snapshot) => snapshot.targetId === targetId) as SettingsSnapshot,
  compare: () => comparisons,
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
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
