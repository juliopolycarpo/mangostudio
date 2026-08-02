import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type {
  LibraryResource,
  LibraryResourceContent,
  LibraryTargetDescriptor,
} from '@mangostudio/shared/library';
import { listLibraryTargetDescriptors } from '@mangostudio/shared/library/host';
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
  const workspaceRoots: (string | undefined)[] = [];
  const service: LibraryRouteService = {
    discover(_userId, force, workspaceRoot) {
      forced.push(force);
      workspaceRoots.push(workspaceRoot);
      return Promise.resolve(resources);
    },
    listLocations(workspaceRoot) {
      workspaceRoots.push(workspaceRoot);
      return [];
    },
    listTargets: () => [],
    readContent: () => content,
  };
  return { service, forced, workspaceRoots };
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
        scope: 'home',
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

  it('accepts a valid workspace root and answers exactly as it does without one', async () => {
    const { service, workspaceRoots } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const plain = await app.handle(new Request('http://localhost/library/resources'));
    const scoped = await app.handle(
      new Request(
        `http://localhost/library/resources?workspaceRoot=${encodeURIComponent(process.cwd())}`
      )
    );

    expect(plain.status).toBe(200);
    expect(scoped.status).toBe(200);
    // The seam is inert in v1: no location resolves under a workspace root, so
    // the parameter is carried to the scanner and changes nothing.
    expect(await scoped.json()).toEqual(await plain.json());
    expect(workspaceRoots).toEqual([undefined, process.cwd()]);
  });

  it('rejects a workspace root that is not a usable directory', async () => {
    const { service, workspaceRoots } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const missing = await app.handle(
      new Request('http://localhost/library/locations?workspaceRoot=/nonexistent-workspace-root')
    );
    const notADirectory = await app.handle(
      new Request(
        `http://localhost/library/resources?workspaceRoot=${encodeURIComponent(
          join(process.cwd(), 'package.json')
        )}`
      )
    );

    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ code: 'VALIDATION' });
    expect(notADirectory.status).toBe(422);
    // A rejected root never reaches the scanner.
    expect(workspaceRoots).toEqual([]);
  });

  it('rejects a relative workspace root rather than resolving it against the server cwd', async () => {
    const { service, workspaceRoots } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, createLibraryRoutes(service));
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/library/locations?workspaceRoot=.')
    );

    expect(response.status).toBe(422);
    expect(workspaceRoots).toEqual([]);
  });

  it('serves the target registry so a filtered matrix keeps every column', async () => {
    const { service } = createService();
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      // The default service is the real registry: the route exists so the
      // client never has to restate the target list or its read precedence.
      createLibraryRoutes({ ...service, listTargets: listLibraryTargetDescriptors })
    );
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/library/targets'));

    expect(response.status).toBe(200);
    const targets = (await response.json()) as LibraryTargetDescriptor[];
    expect(targets.map((target) => target.id)).toEqual([
      'mangostudio',
      'claude',
      'codex',
      'cursor',
    ]);
    // A skill in `agents-skills` covers MangoStudio and Codex from one write,
    // and that fact is only derivable from the per-kind read precedence.
    expect(targets.find((target) => target.id === 'codex')?.reads.skill).toContain('agents-skills');
  });
});
