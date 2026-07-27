import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import type {
  LibraryLocationId,
  PropagationPreview,
  PropagationPreviewEntry,
} from '@mangostudio/shared/library';
import { getDb } from '../../../src/db/database';
import { discoverLibraryResources } from '../../../src/modules/library/application/library-discovery';
import {
  PropagationRequestError,
  previewLibraryPropagation,
} from '../../../src/modules/library/application/propagation-preview';
import {
  createPropagationRoutes,
  type PropagationRouteService,
} from '../../../src/modules/library/http/propagation-routes';
import { LibraryCache } from '../../../src/modules/library/infrastructure/library-cache';
import {
  createLibraryPathEnv,
  describeLocation,
} from '../../../src/modules/library/infrastructure/location-probe';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const TEST_USER = {
  id: 'library-propagation-user',
  name: 'Library Propagation User',
  email: 'library-propagation@mangostudio.test',
};

/** Four peer homes under one temp root, so nothing here touches the real `~`. */
const SKILL_LOCATIONS: readonly LibraryLocationId[] = [
  'mango-skills',
  'agents-skills',
  'claude-skills',
  'cursor-skills',
];

let home: string;
let restoreAuth: (() => void) | null = null;

function skillAt(locationId: LibraryLocationId, body: string): void {
  const directories: Record<string, string> = {
    'mango-skills': join(home, '.mango', 'skills'),
    'agents-skills': join(home, '.agents', 'skills'),
    'claude-skills': join(home, '.claude', 'skills'),
    'cursor-skills': join(home, '.cursor', 'skills'),
  };
  const skillDir = join(directories[locationId] ?? '', 'gh');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: gh\ndescription: GitHub\n---\n${body}`);
}

function emptyLocation(...paths: string[]): void {
  for (const path of paths) mkdirSync(path, { recursive: true });
}

function previewSkills(
  targetLocationIds: readonly LibraryLocationId[]
): Promise<PropagationPreview> {
  const pathEnv = createLibraryPathEnv({
    homeDir: home,
    env: { SKILLS_DIR: join(home, '.mango', 'skills') },
  });
  const cache = new LibraryCache();

  return previewLibraryPropagation(
    TEST_USER.id,
    { resourceKeys: ['skill:gh'], targetLocationIds: [...targetLocationIds] },
    {
      discover: (userId, kinds) =>
        discoverLibraryResources(getDb(), userId, {
          force: true,
          kinds,
          cache,
          pathEnv,
          settings: {
            ...DEFAULT_APP_SETTINGS,
            libraryLocations: Object.fromEntries(
              SKILL_LOCATIONS.map((id) => [id, true])
            ) as (typeof DEFAULT_APP_SETTINGS)['libraryLocations'],
          },
        }),
      describeLocation: (id) => describeLocation(id, pathEnv),
    }
  );
}

function entryOf(preview: PropagationPreview): PropagationPreviewEntry {
  const entry = preview.entries[0];
  if (!entry) throw new Error('Preview returned no entries.');
  return entry;
}

function operationsFor(entry: PropagationPreviewEntry, winnerContentHash: string) {
  return Object.fromEntries(
    entry.destinations.map((destination) => [
      destination.locationId,
      destination.outcomes.find((outcome) => outcome.winnerContentHash === winnerContentHash)
        ?.operation ?? `blocked:${destination.blockedReason}`,
    ])
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mango-propagation-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restoreAuth?.();
  restoreAuth = null;
});

describe('library propagation preview over real locations', () => {
  it('classifies create, overwrite, and noop against the hashes actually on disk', async () => {
    skillAt('mango-skills', 'canonical\n');
    skillAt('agents-skills', 'canonical\n');
    skillAt('claude-skills', 'drifted\n');
    emptyLocation(join(home, '.cursor', 'skills'));

    const preview = await previewSkills(SKILL_LOCATIONS);
    const entry = entryOf(preview);
    const shared = entry.sourceGroups.find((group) => group.instanceCount === 2);
    if (!shared) throw new Error('Expected the two identical copies to form one group.');

    expect(entry.divergence).toBe('divergent');
    expect(entry.requiresWinnerSelection).toBe(true);
    expect(shared.locationIds).toEqual(['agents-skills', 'mango-skills']);
    expect(operationsFor(entry, shared.contentHash)).toEqual({
      'mango-skills': 'noop',
      'agents-skills': 'noop',
      'claude-skills': 'overwrite',
      'cursor-skills': 'create',
    });
  });

  it('reports a resource in sync everywhere rather than hiding it', async () => {
    for (const locationId of SKILL_LOCATIONS) skillAt(locationId, 'identical\n');

    const entry = entryOf(await previewSkills(SKILL_LOCATIONS));
    const [group] = entry.sourceGroups;
    if (!group) throw new Error('Expected one content group.');

    expect(entry.divergence).toBe('uniform');
    expect(entry.requiresWinnerSelection).toBe(false);
    expect(Object.values(operationsFor(entry, group.contentHash))).toEqual([
      'noop',
      'noop',
      'noop',
      'noop',
    ]);
  });

  it('rejects an apply-time replay of a preview taken before a source edit', async () => {
    skillAt('mango-skills', 'first\n');
    emptyLocation(join(home, '.claude', 'skills'));
    const before = await previewSkills(['claude-skills']);

    skillAt('mango-skills', 'second\n');
    const after = await previewSkills(['claude-skills']);

    expect(after.stateHash).not.toBe(before.stateHash);
    expect(after.previewToken).not.toBe(before.previewToken);
  });

  it('rejects an apply-time replay of a preview taken before a destination edit', async () => {
    skillAt('mango-skills', 'source\n');
    emptyLocation(join(home, '.claude', 'skills'));
    const before = await previewSkills(['claude-skills']);

    // The destination is the file that gets clobbered, so a change there has to
    // invalidate the preview just as loudly as a change to the source.
    skillAt('claude-skills', 'someone else was here\n');
    const after = await previewSkills(['claude-skills']);

    expect(after.stateHash).not.toBe(before.stateHash);
  });

  it('keeps the token stable when nothing on disk changed', async () => {
    skillAt('mango-skills', 'stable\n');
    emptyLocation(join(home, '.claude', 'skills'));

    const first = await previewSkills(['claude-skills']);
    const second = await previewSkills(['claude-skills']);

    expect(second.previewToken).toBe(first.previewToken);
  });
});

describe('POST /library/propagate/preview', () => {
  function harness(service: PropagationRouteService) {
    const { app, restore } = createAuthenticatedApiTestApp(
      TEST_USER,
      createPropagationRoutes(service)
    );
    restoreAuth = restore;
    return app;
  }

  function request(body: unknown): Request {
    return new Request('http://localhost/library/propagate/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns the preview for a valid request', async () => {
    skillAt('mango-skills', 'served\n');
    emptyLocation(join(home, '.claude', 'skills'));
    const expected = await previewSkills(['claude-skills']);
    const app = harness({ preview: () => Promise.resolve(expected) });

    const response = await app.handle(
      request({ resourceKeys: ['skill:gh'], targetLocationIds: ['claude-skills'] })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
  });

  it('maps a missing resource to 404 and a malformed request to 422', async () => {
    const app = harness({
      preview: (_userId, body) =>
        Promise.reject(
          new PropagationRequestError(
            body.resourceKeys.includes('skill:missing') ? 404 : 422,
            'Library resource "skill:missing" was not found.'
          )
        ),
    });

    const missing = await app.handle(
      request({ resourceKeys: ['skill:missing'], targetLocationIds: ['claude-skills'] })
    );
    const invalid = await app.handle(
      request({ resourceKeys: ['skill:gh'], targetLocationIds: ['claude-skills'] })
    );

    expect(missing.status).toBe(404);
    expect(invalid.status).toBe(422);
  });

  it('rejects an empty destination list before any scan runs', async () => {
    let scanned = false;
    const app = harness({
      preview: () => {
        scanned = true;
        return Promise.reject(new Error('unreachable'));
      },
    });

    const response = await app.handle(
      request({ resourceKeys: ['skill:gh'], targetLocationIds: [] })
    );

    expect(response.status).toBe(422);
    expect(scanned).toBe(false);
  });
});
