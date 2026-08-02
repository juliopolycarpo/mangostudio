/**
 * Per-environment library discovery caches must not cross-pollinate.
 */

import { describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getDb } from '../../../../src/db/database';
import { createEnvironmentLibraryService } from '../../../../src/modules/library/application/environment-library-service';
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

    expect(local.map((resource) => resource.ref.slug)).toEqual([LOCAL_ENVIRONMENT_ID]);
    expect(remote.map((resource) => resource.ref.slug)).toEqual(['remote-a']);
    expect(localAgain.map((resource) => resource.ref.slug)).toEqual([LOCAL_ENVIRONMENT_ID]);
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
        scan: () => Promise.resolve({ entries: [] }),
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
        scan: () => Promise.resolve({ entries: [] }),
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
});
