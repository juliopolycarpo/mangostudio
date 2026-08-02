/**
 * Per-environment library discovery caches must not cross-pollinate.
 */

import { describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getDb } from '../../../../src/db/database';
import { createEnvironmentLibraryService } from '../../../../src/modules/library/application/environment-library-service';
import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';

describe('createEnvironmentLibraryService', () => {
  it('keeps scan results partitioned by environment id', async () => {
    const userId = 'library-env-cache-user';
    const scans: string[] = [];
    const makeClient = (environmentId: string): RuntimeClient =>
      ({
        manifest: {
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
            library: true,
            checkpoints: true,
          },
        },
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
});
