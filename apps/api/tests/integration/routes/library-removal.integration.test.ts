import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_APP_SETTINGS,
  libraryLocationsFor,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import type {
  LibraryLocationId,
  RemovalApplyRequest,
  RemovalPreview,
  RemovalPreviewEntry,
} from '@mangostudio/shared/library';
import { enabledLibraryLocations } from '@mangostudio/shared/library';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { getDb } from '../../../src/db/database';
import { discoverLibraryResources } from '../../../src/modules/library/application/library-discovery';
import { undoLibraryPropagation } from '../../../src/modules/library/application/propagation-apply';
import { applyLibraryRemoval } from '../../../src/modules/library/application/removal-apply';
import { previewLibraryRemoval } from '../../../src/modules/library/application/removal-preview';
import {
  createRemovalRoutes,
  type RemovalRouteService,
} from '../../../src/modules/library/http/removal-routes';
import {
  type BackupStoreDeps,
  defaultBackupStoreDeps,
} from '../../../src/modules/library/infrastructure/backup-store';
import { LibraryCache } from '../../../src/modules/library/infrastructure/library-cache';
import {
  createLibraryPathEnv,
  describeLocation,
} from '../../../src/modules/library/infrastructure/location-probe';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'library-removal-user',
  name: 'Library Removal User',
  email: 'library-removal@mangostudio.test',
};

/** Four peer homes under one temp root, so nothing here touches the real `~`. */
const SKILL_LOCATIONS: readonly LibraryLocationId[] = [
  'mango-skills',
  'agents-skills',
  'claude-skills',
  'cursor-skills',
];

const SKILL_DIRECTORIES: Record<string, readonly string[]> = {
  'mango-skills': ['.mango', 'skills'],
  'agents-skills': ['.agents', 'skills'],
  'claude-skills': ['.claude', 'skills'],
  'cursor-skills': ['.cursor', 'skills'],
};

let home: string;
let backupRoot: string;
const authRestores: (() => void)[] = [];

function skillAt(locationId: LibraryLocationId, body: string): string {
  const skillDir = join(home, ...(SKILL_DIRECTORIES[locationId] ?? []), 'gh');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: gh\ndescription: GitHub\n---\n${body}`);
  return skillDir;
}

function libraryPathEnv() {
  return createLibraryPathEnv({
    homeDir: home,
    env: { SKILLS_DIR: join(home, '.mango', 'skills') },
  });
}

function skillLocationSettings(): typeof DEFAULT_APP_SETTINGS {
  return withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
    home: Object.fromEntries(SKILL_LOCATIONS.map((id) => [id, true])),
    workspace: {},
  });
}

function backupDeps(): BackupStoreDeps {
  return {
    ...defaultBackupStoreDeps,
    backupDir: () => backupRoot,
    retentionCount: () => 10,
    retentionBytes: () => 1024 ** 3,
  };
}

function previewRemoval(
  locationIds: readonly LibraryLocationId[],
  userId: string = TEST_USER.id
): Promise<RemovalPreview> {
  const pathEnv = libraryPathEnv();
  const cache = new LibraryCache();

  return previewLibraryRemoval(
    userId,
    { resourceKeys: ['skill:gh'], locationIds: [...locationIds] },
    {
      snapshot: async (scanUserId, environmentId, kinds) => ({
        environmentId,
        resources: (
          await discoverLibraryResources(getDb(), scanUserId, {
            force: true,
            kinds,
            cache,
            pathEnv,
            settings: skillLocationSettings(),
          })
        ).resources,
        statuses: new Map(
          [...locationIds].map((id) => [id, describeLocation(id, pathEnv)] as const)
        ),
      }),
      enabledLocationIds: () =>
        Promise.resolve(
          enabledLibraryLocations(libraryLocationsFor(skillLocationSettings()), 'home')
        ),
      pathEnv: libraryPathEnv,
    }
  );
}

function applyRemoval(request: RemovalApplyRequest, userId: string = TEST_USER.id) {
  return applyLibraryRemoval(userId, request, {
    preview: (previewUserId, previewRequest) =>
      previewRemoval(previewRequest.locationIds, previewUserId),
    pathEnv: libraryPathEnv,
    // Drives the engine directly against this suite's temp home; the runtime
    // engine would resolve locations against the real one.
    writeEngine: 'in-process',
    backup: backupDeps(),
  });
}

function entryOf(preview: RemovalPreview): RemovalPreviewEntry {
  const entry = preview.entries[0];
  if (!entry) throw new Error('Preview returned no entries.');
  return entry;
}

function removeEverything(
  preview: RemovalPreview,
  options: { readonly acknowledge?: boolean; readonly keep?: readonly string[] } = {}
): RemovalApplyRequest {
  const keep = new Set(options.keep ?? []);
  return {
    previewToken: preview.previewToken,
    stateHash: preview.stateHash,
    request: {
      resourceKeys: ['skill:gh'],
      locationIds: entryOf(preview).locations.map((location) => location.locationId),
    },
    decisions: preview.entries.map((entry) => ({
      resourceKey: entry.resourceKey,
      locations: entry.locations.map((location) => ({
        locationId: location.locationId,
        action:
          location.operation === 'remove' && !keep.has(location.locationId)
            ? ('remove' as const)
            : ('keep' as const),
      })),
    })),
    acknowledgeLastCopy: options.acknowledge ? ['skill:gh'] : [],
  };
}

async function currentDivergence(): Promise<string | undefined> {
  const { resources } = await discoverLibraryResources(getDb(), TEST_USER.id, {
    force: true,
    kinds: ['skill'],
    cache: new LibraryCache(),
    pathEnv: libraryPathEnv(),
    settings: skillLocationSettings(),
  });
  return resources.find((resource) => resource.key === 'skill:gh')?.divergence;
}

const unsupportedService: RemovalRouteService = {
  preview: () => Promise.reject(new Error('preview not stubbed')),
  apply: () => Promise.reject(new Error('apply not stubbed')),
};

function harness(service: Partial<RemovalRouteService>) {
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createRemovalRoutes({ ...unsupportedService, ...service })
  );
  authRestores.push(restore);
  return app;
}

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mango-removal-integration-'));
  backupRoot = join(home, 'backups');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const restore of authRestores.reverse()) restore();
  authRestores.length = 0;
});

describe('library removal over real locations', () => {
  it('classifies every peer home against what is actually on disk', async () => {
    skillAt('mango-skills', 'canonical\n');
    skillAt('claude-skills', 'drifted\n');
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(home, '.cursor', 'skills'), { recursive: true });

    const entry = entryOf(await previewRemoval(SKILL_LOCATIONS));
    const operations = Object.fromEntries(
      entry.locations.map((location) => [location.locationId, location.operation])
    );

    expect(operations).toEqual({
      'mango-skills': 'remove',
      'agents-skills': 'absent',
      'claude-skills': 'remove',
      'cursor-skills': 'absent',
    });
    // Two versions, one copy each: removing either takes its version with it.
    expect(entry.locations.filter((location) => location.eliminatesContentGroup)).toHaveLength(2);
    expect(entry.wouldRemoveLastCopy).toBe(true);
  });

  it('removes every copy, then restores them all through the shared undo route', async () => {
    const paths = SKILL_LOCATIONS.map((locationId) => skillAt(locationId, 'identical\n'));
    expect(await currentDivergence()).toBe('uniform');

    const preview = await previewRemoval(SKILL_LOCATIONS);
    const result = await applyRemoval(removeEverything(preview, { acknowledge: true }));

    expect(result.partial).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.removed).toHaveLength(4);
    expect(paths.filter((path) => existsSync(path))).toEqual([]);
    expect(await currentDivergence()).toBeUndefined();

    const undone = await undoLibraryPropagation(result.backupId ?? '', {
      backup: backupDeps(),
      pathEnv: libraryPathEnv,
      writeEngine: 'in-process',
    });

    expect(undone.restored).toHaveLength(4);
    expect(paths.every((path) => existsSync(path))).toBe(true);
    expect(await currentDivergence()).toBe('uniform');
  });

  it('resolves a divergence by removing the copy the user does not want', async () => {
    skillAt('mango-skills', 'keep this\n');
    skillAt('claude-skills', 'drifted\n');
    expect(await currentDivergence()).toBe('divergent');

    const preview = await previewRemoval(['claude-skills']);
    const result = await applyRemoval(removeEverything(preview));

    expect(result.failed).toEqual([]);
    expect(result.removed).toHaveLength(1);
    // Deleting the version you do not want is a legitimate resolution, and it
    // needs no last-copy acknowledgement while another copy survives.
    expect(await currentDivergence()).toBe('single');
  });

  it('rejects an apply whose preview no longer describes the disk', async () => {
    skillAt('mango-skills', 'before\n');
    skillAt('claude-skills', 'before\n');
    const preview = await previewRemoval(['claude-skills']);

    skillAt('claude-skills', 'edited after previewing\n');

    await expect(applyRemoval(removeEverything(preview))).rejects.toMatchObject({ status: 409 });
    expect(existsSync(join(home, '.claude', 'skills', 'gh'))).toBe(true);
  });
});

describe('POST /library/removal/apply', () => {
  it('answers a last-copy removal with a code the client can act on', async () => {
    skillAt('mango-skills', 'only copy\n');
    const preview = await previewRemoval(['mango-skills']);
    const app = harness({ apply: (_userId, request) => applyRemoval(request) });

    const response = await app.handle(
      jsonRequest('/library/removal/apply', 'POST', removeEverything(preview))
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'LAST_COPY_UNACKNOWLEDGED' });
    expect(existsSync(join(home, '.mango', 'skills', 'gh'))).toBe(true);
  });

  it('removes the last copy once the request acknowledges it', async () => {
    const path = skillAt('mango-skills', 'only copy\n');
    const preview = await previewRemoval(['mango-skills']);
    const app = harness({ apply: (_userId, request) => applyRemoval(request) });

    const response = await app.handle(
      jsonRequest(
        '/library/removal/apply',
        'POST',
        removeEverything(preview, { acknowledge: true })
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ partial: false });
    expect(existsSync(path)).toBe(false);
  });
});

describe('POST /library/removal/preview', () => {
  it('serves the preview a client needs to decide', async () => {
    skillAt('mango-skills', 'served\n');
    const app = harness({ preview: (_userId, request) => previewRemoval(request.locationIds) });

    const response = await app.handle(
      jsonRequest('/library/removal/preview', 'POST', {
        resourceKeys: ['skill:gh'],
        locationIds: ['mango-skills'],
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as RemovalPreview;
    expect(body.entries[0]?.locations[0]?.operation).toBe('remove');
    expect(body.staleStagedRemovals).toEqual([]);
  });
});
