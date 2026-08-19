/**
 * Per-environment library discovery caches must not cross-pollinate.
 */

import { describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getDb } from '../../../../src/db/database';
import {
  createEnvironmentLibraryService,
  resetLibraryCachesForEnvironments,
} from '../../../../src/modules/library/application/environment-library-service';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';

function makeManifest(environmentId: string, library = true) {
  return {
    platform: process.platform,
    arch: process.arch,
    pathStyle: process.platform === 'win32' ? 'win32' : 'posix',
    homeDir: `/tmp/${environmentId}`,
    shells: [],
    git: { available: false },
    features: {
      tools: true,
      git: true,
      probing: true,
      mcp: true,
      library,
      checkpoints: true,
    },
  };
}

describe('createEnvironmentLibraryService', () => {
  it('keeps scan results partitioned by environment id', async () => {
    const userId = 'library-env-cache-user';
    const scans: string[] = [];
    const makeClient = (environmentId: string): RuntimeClient =>
      ({
        manifest: makeManifest(environmentId),
        library: {
          scan: () => {
            scans.push(environmentId);
            return Promise.resolve({
              entries: [
                {
                  ref: { kind: 'skill', slug: environmentId },
                  instance: {
                    locationId: 'mango-skills',
                    path: `/tmp/${environmentId}/skills/${environmentId}`,
                    modifiedAtMs: 1,
                    format: 'markdown-frontmatter',
                    title: environmentId,
                    description: environmentId,
                    valid: true,
                    contentHash: environmentId,
                    sizeBytes: 1,
                  },
                },
              ],
              unreadableEntries: [],
            });
          },
          read: () => Promise.resolve({ content: '', truncated: false, sizeBytes: 0 }),
          locations: () => Promise.resolve({ locations: [] }),
        },
      }) as unknown as RuntimeClient;

    const clients = new Map<string, RuntimeClient>([
      [LOCAL_ENVIRONMENT_ID, makeClient(LOCAL_ENVIRONMENT_ID)],
      ['remote-a', makeClient('remote-a')],
    ]);

    const service = createEnvironmentLibraryService({
      resolveClient: (scope) => {
        const client = clients.get(scope.environmentId);
        if (!client) return Promise.reject(new Error(`missing client for ${scope.environmentId}`));
        return Promise.resolve(client);
      },
      now: () => 1_000,
      cacheTtlMs: 60_000,
    });

    const local = await service.discover(getDb(), {
      userId,
      environmentId: LOCAL_ENVIRONMENT_ID,
    });
    const remote = await service.discover(getDb(), {
      userId,
      environmentId: 'remote-a',
    });
    const localAgain = await service.discover(getDb(), {
      userId,
      environmentId: LOCAL_ENVIRONMENT_ID,
    });

    expect(local.resources.map((resource) => resource.ref.slug)).toEqual([LOCAL_ENVIRONMENT_ID]);
    expect(remote.resources.map((resource) => resource.ref.slug)).toEqual(['remote-a']);
    expect(localAgain.resources.map((resource) => resource.ref.slug)).toEqual([
      LOCAL_ENVIRONMENT_ID,
    ]);
    // Second local discover hit the cache; only one scan per environment.
    expect(scans).toEqual([LOCAL_ENVIRONMENT_ID, 'remote-a']);
  });

  it('names the location for a content read and lets the runtime resolve its root', async () => {
    const userId = 'library-env-read-roots-user';
    const instancePath = '/tmp/remote-b/skills/gh';
    let readParams: { path: string; locationId: string } | undefined;

    const resource = {
      ref: { kind: 'skill' as const, slug: 'gh' },
      key: 'skill:gh',
      instances: [
        {
          locationId: 'mango-skills' as const,
          path: instancePath,
          modifiedAtMs: 1,
          format: 'markdown-frontmatter' as const,
          title: 'gh',
          description: 'gh',
          valid: true as const,
          contentHash: 'hash',
          sizeBytes: 1,
        },
      ],
      coverage: [],
      divergence: 'single' as const,
      whitespaceOnlyDivergence: false,
      contentGroups: [],
    };

    const client = {
      manifest: makeManifest('remote-b'),
      library: {
        scan: () => Promise.resolve({ entries: [], unreadableEntries: [] }),
        read: (params: { path: string; locationId: string }) => {
          readParams = params;
          return Promise.resolve({
            content: '# Skill',
            truncated: false,
            sizeBytes: 7,
            denied: false,
          });
        },
        locations: () => Promise.resolve({ locations: [] }),
      },
    } as unknown as RuntimeClient;

    const service = createEnvironmentLibraryService({
      resolveClient: () => Promise.resolve(client),
    });

    const content = await service.readContent(
      getDb(),
      { userId, environmentId: 'remote-b' },
      resource,
      'mango-skills'
    );

    expect(content?.content).toBe('# Skill');
    expect(readParams?.locationId).toBe('mango-skills');
    expect(readParams?.path).toBe(`${instancePath}/SKILL.md`);
  });

  // Parity with the pre-relocation route: a scan can report an instance whose
  // metadata is invalid and whose file is still perfectly readable, and the
  // detail view is where a user goes to find out why it is flagged.
  it('serves content for an instance the scan flagged invalid', async () => {
    const userId = 'library-env-invalid-read-user';
    const instancePath = '/tmp/remote-c/instructions/AGENTS.md';

    const resource = {
      ref: { kind: 'instruction' as const, slug: 'agents' },
      key: 'instruction:agents',
      instances: [
        {
          locationId: 'mango-instructions' as const,
          path: instancePath,
          modifiedAtMs: 1,
          format: 'markdown-plain' as const,
          valid: false as const,
          invalidReason: 'invalid-metadata' as const,
          contentHash: 'hash',
          sizeBytes: 1,
        },
      ],
      coverage: [],
      divergence: 'single' as const,
      whitespaceOnlyDivergence: false,
      contentGroups: [],
    };

    const client = {
      manifest: makeManifest('remote-c'),
      library: {
        scan: () => Promise.resolve({ entries: [], unreadableEntries: [] }),
        read: () =>
          Promise.resolve({ content: '# Agents', truncated: false, sizeBytes: 8, denied: false }),
        locations: () => Promise.resolve({ locations: [] }),
      },
    } as unknown as RuntimeClient;

    const content = await createEnvironmentLibraryService({
      resolveClient: () => Promise.resolve(client),
    }).readContent(getDb(), { userId, environmentId: 'remote-c' }, resource, 'mango-instructions');

    expect(content?.content).toBe('# Agents');
  });

  it('reads locations through the shared probing-service cache', async () => {
    const client = {
      manifest: makeManifest('remote-d'),
      library: {
        scan: () => Promise.resolve({ entries: [], unreadableEntries: [] }),
        read: () => Promise.resolve({ content: '', truncated: false, sizeBytes: 0 }),
        locations: () => Promise.reject(new Error('should not call the runtime directly')),
      },
    } as unknown as RuntimeClient;
    const calls: unknown[] = [];
    const location = {
      id: 'mango-skills' as const,
      kind: 'skill' as const,
      scope: 'home' as const,
      path: '/tmp/remote-d/skills',
      access: 'read-write' as const,
      exists: true,
      readable: true,
      writable: true,
      targetIds: ['mangostudio' as const],
    };

    const service = createEnvironmentLibraryService({
      resolveClient: () => Promise.resolve(client),
      listLocationStatuses: (scope) => {
        calls.push(scope);
        return Promise.resolve([location]);
      },
    });

    const locations = await service.listLocations(getDb(), {
      userId: 'library-env-locations-user',
      environmentId: 'remote-d',
    });

    expect(locations).toEqual([location]);
    expect(calls).toEqual([{ userId: 'library-env-locations-user', environmentId: 'remote-d' }]);
  });

  it('forwards resetCache to the probing location cache', () => {
    const resetCalls: Array<string | undefined> = [];
    const service = createEnvironmentLibraryService({
      resetLocationCache: (environmentId) => {
        resetCalls.push(environmentId);
      },
    });

    service.resetCache('remote-d');
    service.resetCache();

    expect(resetCalls).toEqual(['remote-d', undefined]);
  });

  it('drops the shared location cache when a rescan is forced', async () => {
    const client = {
      manifest: makeManifest('remote-f'),
      library: {
        scan: () => Promise.resolve({ entries: [], unreadableEntries: [] }),
        read: () => Promise.resolve({ content: '', truncated: false, sizeBytes: 0 }),
      },
    } as unknown as RuntimeClient;
    const resetCalls: Array<string | undefined> = [];
    const service = createEnvironmentLibraryService({
      resolveClient: () => Promise.resolve(client),
      resetLocationCache: (environmentId) => {
        resetCalls.push(environmentId);
      },
    });
    const scope = { userId: 'library-force-rescan-user', environmentId: 'remote-f' };

    await service.discover(getDb(), scope);
    expect(resetCalls).toEqual([]);

    await service.discover(getDb(), scope, { force: true });
    expect(resetCalls).toEqual(['remote-f']);
  });

  it('scans through a caller-supplied client instead of resolving a new one', async () => {
    const scans: string[] = [];
    const makeClient = (label: string): RuntimeClient =>
      ({
        manifest: makeManifest('remote-g'),
        library: {
          scan: () => {
            scans.push(label);
            return Promise.resolve({ entries: [], unreadableEntries: [] });
          },
        },
      }) as unknown as RuntimeClient;
    const resolved = makeClient('resolved');
    const supplied = makeClient('supplied');
    const resolveCalls: string[] = [];
    const service = createEnvironmentLibraryService({
      resolveClient: () => {
        resolveCalls.push('resolved');
        return Promise.resolve(resolved);
      },
    });

    await service.discover(
      getDb(),
      { userId: 'library-supplied-client-user', environmentId: 'remote-g' },
      { force: true, client: supplied }
    );

    expect(scans).toEqual(['supplied']);
    expect(resolveCalls).toEqual([]);
  });

  it('resetLibraryCachesForEnvironments drops each environment once', () => {
    const resetCalls: string[] = [];
    resetLibraryCachesForEnvironments(
      [{ environmentId: 'a' }, { environmentId: 'a' }, { environmentId: 'b' }],
      {
        resetCache: (environmentId) => {
          if (environmentId) resetCalls.push(environmentId);
        },
      }
    );
    expect(resetCalls).toEqual(['a', 'b']);
  });
});
