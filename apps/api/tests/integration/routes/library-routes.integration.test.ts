import { afterEach, describe, expect, it } from 'bun:test';
import type { LibraryResource, LibraryResourceContent } from '@mangostudio/shared/library';
import {
  createLibraryRoutes,
  type LibraryRouteService,
  MAX_LIBRARY_CONTENT_BYTES,
} from '../../../src/modules/library/http/library-routes';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'library-routes-user',
  name: 'Library Routes User',
  email: 'library-routes@mangostudio.test',
};

const skillResource: LibraryResource = {
  ref: { kind: 'skill', slug: 'gh' },
  key: 'skill:gh',
  instances: [
    {
      locationId: 'agents-skills',
      path: '/home/test/.agents/skills/gh',
      modifiedAtMs: 1,
      format: 'markdown-frontmatter',
      title: 'gh',
      description: 'GitHub workflows',
      valid: true,
      contentHash: 'hash',
      sizeBytes: 10,
    },
  ],
  coverage: [
    {
      targetId: 'mangostudio',
      state: 'present',
      effectiveLocationId: 'agents-skills',
      shadowedLocationIds: [],
    },
    {
      targetId: 'claude',
      state: 'absent',
      shadowedLocationIds: [],
    },
    {
      targetId: 'codex',
      state: 'present',
      effectiveLocationId: 'agents-skills',
      shadowedLocationIds: [],
    },
    {
      targetId: 'cursor',
      state: 'absent',
      shadowedLocationIds: [],
    },
  ],
  divergence: 'single',
  whitespaceOnlyDivergence: false,
  contentGroups: [
    {
      contentHash: 'hash',
      locationIds: ['agents-skills'],
      instanceCount: 1,
    },
  ],
};

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function createService(resources: LibraryResource[] = [skillResource]) {
  const forced: boolean[] = [];
  const content: LibraryResourceContent = {
    key: 'skill:gh',
    locationId: 'agents-skills',
    content: '# Skill',
    truncated: false,
    sizeBytes: 7,
  };
  const service: LibraryRouteService = {
    discover(_userId, force) {
      forced.push(force);
      return Promise.resolve(resources);
    },
    listLocations: () => [],
    readContent: () => content,
  };
  return { service, forced };
}

describe('library routes', () => {
  it('filters resources by kind, target, location, and coverage state', async () => {
    const { service } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request(
        'http://localhost/library/resources?kind=skill&target=codex&location=agents-skills&state=present'
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([skillResource]);
  });

  it('returns detail and bounded content by validated resource key and location', async () => {
    const { service } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const detail = await app.handle(new Request('http://localhost/library/resources/skill:gh'));
    const content = await app.handle(
      new Request('http://localhost/library/resources/skill:gh/content?location=agents-skills')
    );

    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(skillResource);
    expect(content.status).toBe(200);
    expect(await content.json()).toMatchObject({
      content: '# Skill',
      truncated: false,
    });
    expect(MAX_LIBRARY_CONTENT_BYTES).toBe(512 * 1024);
  });

  it('rejects malformed keys before resource lookup', async () => {
    const { service, forced } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/resources/not-a-resource-key')
    );

    expect(response.status).toBe(400);
    expect(forced).toEqual([]);
  });

  it('forces both cache levels through the rescan route', async () => {
    const { service, forced } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/rescan?force=true', { method: 'POST' })
    );

    expect(response.status).toBe(200);
    expect(forced).toEqual([true]);
  });

  it('returns location health from the registry service', async () => {
    const { service } = createService();
    service.listLocations = () => [
      {
        id: 'agents-skills',
        kind: 'skill',
        path: '/home/test/.agents/skills',
        access: 'read-write',
        exists: true,
        readable: true,
        writable: true,
        targetIds: ['mangostudio', 'codex'],
        entryCount: 1,
      },
    ];
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/library/locations'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(service.listLocations());
  });
});
