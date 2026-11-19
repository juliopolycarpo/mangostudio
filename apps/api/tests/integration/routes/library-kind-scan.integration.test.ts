/**
 * Issue #965: `GET /library/resources?kind=command` used to walk every location
 * of every kind and drop most of the result afterwards. The kind has to reach
 * the scan, so a single-kind request scans a single kind, and the answer stays
 * what the post-scan filter would have produced.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import type { LibraryLocationId, ResourceKind } from '@mangostudio/shared/library';
import { LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';

import {
  createEnvironmentLibraryService,
  type EnvironmentLibraryService,
} from '../../../src/modules/library/application/environment-library-service';
import {
  createLibraryRoutes,
  createLibraryRouteService,
} from '../../../src/modules/library/http/library-routes';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'library-kind-scan-user',
  name: 'Library Kind Scan User',
  email: 'library-kind-scan@mangostudio.test',
};

const SCANNED_KINDS: readonly ResourceKind[] = ['skill', 'command', 'subagent'];

/** One location per scanned kind, taken from the registry so the ids stay real. */
const LOCATION_BY_KIND = new Map<ResourceKind, LibraryLocationId>(
  SCANNED_KINDS.map((kind) => {
    const definition = LIBRARY_LOCATION_DEFINITIONS.find((location) => location.kind === kind);
    if (!definition) throw new Error(`expected a registry location for kind ${kind} | got none`);
    return [kind, definition.id];
  })
);

/**
 * Named fake for the runtime's library scan. Like the real runtime it walks only
 * the locations whose kind was asked for, and it records every walk so a test
 * can say which kinds a request paid for.
 */
class FakeLibraryRuntime {
  readonly scans: { readonly requestedKinds: readonly ResourceKind[] | undefined }[] = [];
  readonly walkedKinds: ResourceKind[] = [];

  asRuntimeClient(): RuntimeClient {
    return {
      manifest: {
        platform: 'linux',
        arch: 'x64',
        pathStyle: 'posix',
        homeDir: '/home/fake',
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
        scan: (params: { kinds?: readonly ResourceKind[] }) => {
          this.scans.push({ requestedKinds: params.kinds });
          const entries = [];
          for (const kind of SCANNED_KINDS) {
            if (params.kinds && !params.kinds.includes(kind)) continue;
            this.walkedKinds.push(kind);
            const locationId = LOCATION_BY_KIND.get(kind) as LibraryLocationId;
            entries.push({
              ref: { kind, slug: `${kind}-sample` },
              instance: {
                locationId,
                path: `/home/fake/${locationId}/${kind}-sample`,
                modifiedAtMs: 1,
                format: 'markdown-frontmatter',
                title: `${kind}-sample`,
                description: `A ${kind}`,
                valid: true,
                contentHash: `hash-${kind}`,
                sizeBytes: 10,
              },
            });
          }
          return Promise.resolve({ entries, unreadableEntries: [] });
        },
      },
    } as unknown as RuntimeClient;
  }
}

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function mountLibraryOver(runtime: FakeLibraryRuntime) {
  const library: EnvironmentLibraryService = createEnvironmentLibraryService({
    resolveClient: () => Promise.resolve(runtime.asRuntimeClient()),
  });
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createLibraryRoutes(createLibraryRouteService(library))
  );
  restoreAuth = restore;
  return app;
}

async function getResources(app: ReturnType<typeof mountLibraryOver>, query: string) {
  const response = await app.handle(new Request(`http://localhost/library/resources${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    resources: { ref: { kind: ResourceKind } }[];
    unreadableEntries: unknown[];
  };
}

describe('GET /library/resources kind filter', () => {
  it('scans only the requested kind', async () => {
    const runtime = new FakeLibraryRuntime();
    const app = mountLibraryOver(runtime);

    await getResources(app, '?kind=command');

    expect(
      runtime.walkedKinds,
      `(library scan): expected walked kinds for ?kind=command: command | received: ${runtime.walkedKinds.join(', ')}`
    ).toEqual(['command']);
  });

  it('answers with the same resources the post-scan filter would have kept', async () => {
    const everything = await getResources(mountLibraryOver(new FakeLibraryRuntime()), '');
    const narrowed = await getResources(
      mountLibraryOver(new FakeLibraryRuntime()),
      '?kind=command'
    );

    expect(narrowed.resources).toEqual(
      everything.resources.filter((resource) => resource.ref.kind === 'command')
    );
    expect(narrowed.resources).toHaveLength(1);
    expect(narrowed.unreadableEntries).toEqual([]);
  });

  it('still scans every kind when no kind is requested', async () => {
    const runtime = new FakeLibraryRuntime();
    const app = mountLibraryOver(runtime);

    const body = await getResources(app, '');

    expect(runtime.scans).toEqual([{ requestedKinds: undefined }]);
    expect(body.resources.map((resource) => resource.ref.kind).sort()).toEqual(
      [...SCANNED_KINDS].sort()
    );
  });

  it('keeps a kind-filtered scan apart from the full scan in the cache', async () => {
    const runtime = new FakeLibraryRuntime();
    const app = mountLibraryOver(runtime);

    const narrowed = await getResources(app, '?kind=command');
    const everything = await getResources(app, '');

    expect(narrowed.resources.map((resource) => resource.ref.kind)).toEqual(['command']);
    expect(everything.resources).toHaveLength(SCANNED_KINDS.length);
    expect(runtime.scans.map((scan) => scan.requestedKinds)).toEqual([['command'], undefined]);
  });
});
