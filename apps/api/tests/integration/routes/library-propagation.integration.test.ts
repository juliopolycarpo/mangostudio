import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_APP_SETTINGS,
  libraryLocationsFor,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import type {
  LibraryLocationId,
  PropagationBackupUsage,
  PropagationPreview,
  PropagationPreviewEntry,
} from '@mangostudio/shared/library';
import { enabledLibraryLocations } from '@mangostudio/shared/library';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { getDb } from '../../../src/db/database';
import {
  acknowledgeDivergence,
  type DivergenceAckDeps,
  listDivergenceAcks,
} from '../../../src/modules/library/application/conflict-resolution';
import { discoverLibraryResources } from '../../../src/modules/library/application/library-discovery';
import { previewLibraryPropagation } from '../../../src/modules/library/application/propagation-preview';
import { LibraryRequestError } from '../../../src/modules/library/domain/library-request-error';
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
/**
 * One test can mount more than one stub service, and each mount patches the
 * shared auth module. Keeping every restore and undoing them in reverse stops a
 * later mount's restore from reinstating an earlier mount's patch.
 */
const authRestores: (() => void)[] = [];

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

function previewSkills(
  targetLocationIds: readonly LibraryLocationId[],
  userId: string = TEST_USER.id
): Promise<PropagationPreview> {
  const pathEnv = libraryPathEnv();
  const cache = new LibraryCache();

  return previewLibraryPropagation(
    userId,
    { resourceKeys: ['skill:gh'], targetLocationIds: [...targetLocationIds] },
    {
      snapshot: async (scanUserId, environmentId, kinds) => ({
        environmentId,
        resources: await discoverLibraryResources(getDb(), scanUserId, {
          force: true,
          kinds,
          cache,
          pathEnv,
          settings: skillLocationSettings(),
        }),
        statuses: new Map(
          [...targetLocationIds].map((id) => [id, describeLocation(id, pathEnv)] as const)
        ),
      }),
      enabledLocationIds: async () =>
        enabledLibraryLocations(libraryLocationsFor(skillLocationSettings()), 'home'),
    }
  );
}

/** Drives the real acknowledgement store against the temp locations. */
function ackDeps(): Partial<DivergenceAckDeps> {
  return {
    discover: (userId, ref) =>
      discoverLibraryResources(getDb(), userId, {
        force: true,
        kinds: [ref.kind],
        cache: new LibraryCache(),
        pathEnv: libraryPathEnv(),
        settings: skillLocationSettings(),
      }),
  };
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
  for (const restore of authRestores.reverse()) restore();
  authRestores.length = 0;
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

const unsupportedService: PropagationRouteService = {
  preview: () => Promise.reject(new Error('preview not stubbed')),
  apply: () => Promise.reject(new Error('apply not stubbed')),
  undo: () => Promise.reject(new Error('undo not stubbed')),
  backupUsage: () => Promise.reject(new Error('backupUsage not stubbed')),
  purgeBackup: () => Promise.reject(new Error('purgeBackup not stubbed')),
  listAcks: () => Promise.reject(new Error('listAcks not stubbed')),
  acknowledge: () => Promise.reject(new Error('acknowledge not stubbed')),
  forgetAck: () => Promise.reject(new Error('forgetAck not stubbed')),
};

function harness(service: Partial<PropagationRouteService>) {
  const { app, restore } = createAuthenticatedApiTestApp(
    TEST_USER,
    createPropagationRoutes({ ...unsupportedService, ...service })
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

describe('POST /library/propagate/preview', () => {
  const request = (body: unknown) => jsonRequest('/library/propagate/preview', 'POST', body);

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
          new LibraryRequestError(
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

describe('library divergence acknowledgements', () => {
  let ackUser = 0;
  // A fresh user per test keeps one suite's acknowledgements out of the next's.
  function nextUser(): string {
    ackUser += 1;
    return `library-ack-user-${ackUser}`;
  }

  it('stops flagging a divergence the user accepted, and flags it again after an edit', async () => {
    const userId = nextUser();
    skillAt('mango-skills', 'mine\n');
    skillAt('claude-skills', 'theirs\n');

    const before = entryOf(await previewSkills(SKILL_LOCATIONS, userId));
    expect(before.acknowledgedDivergence).toBe(false);

    await acknowledgeDivergence(
      userId,
      {
        resourceKey: 'skill:gh',
        contentHashes: before.sourceGroups.map((group) => group.contentHash),
      },
      ackDeps()
    );

    const acknowledged = entryOf(await previewSkills(SKILL_LOCATIONS, userId));
    expect(acknowledged.acknowledgedDivergence).toBe(true);
    expect(acknowledged.requiresWinnerSelection).toBe(true);

    // Acknowledging *this* divergence is not a permanent mute: changing a copy
    // produces a divergence nobody has looked at yet.
    skillAt('claude-skills', 'theirs, edited\n');
    const afterEdit = entryOf(await previewSkills(SKILL_LOCATIONS, userId));

    expect(afterEdit.acknowledgedDivergence).toBe(false);
    expect(await listDivergenceAcks(userId)).toEqual([]);
  });

  it('refuses to record hashes that disagree with the rescan', async () => {
    const userId = nextUser();
    skillAt('mango-skills', 'mine\n');
    skillAt('claude-skills', 'theirs\n');
    const entry = entryOf(await previewSkills(SKILL_LOCATIONS, userId));

    skillAt('claude-skills', 'changed underneath\n');
    const failure = acknowledgeDivergence(
      userId,
      {
        resourceKey: 'skill:gh',
        contentHashes: entry.sourceGroups.map((group) => group.contentHash),
      },
      ackDeps()
    );

    await expect(failure).rejects.toMatchObject({ status: 409 });
    expect(await listDivergenceAcks(userId)).toEqual([]);
  });
});

describe('divergence acknowledgement routes', () => {
  const ack = {
    resourceKey: 'skill:gh',
    contentHashes: ['hash-a', 'hash-b'],
    acknowledgedAtMs: 5,
  };

  it('lists acknowledgements', async () => {
    const app = harness({ listAcks: () => Promise.resolve([ack]) });

    const response = await app.handle(jsonRequest('/library/divergence/acks', 'GET'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([ack]);
  });

  it('records an acknowledgement and reports a stale one as a conflict', async () => {
    const recorded = harness({ acknowledge: () => Promise.resolve(ack) });
    const created = await recorded.handle(
      jsonRequest('/library/divergence/acks', 'POST', {
        resourceKey: 'skill:gh',
        contentHashes: ['hash-a', 'hash-b'],
      })
    );
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual(ack);

    const withProfile = await recorded.handle(
      jsonRequest('/library/divergence/acks', 'POST', {
        resourceKey: 'skill:gh',
        contentHashes: ['hash-a', 'hash-b'],
        profileId: 'default',
      })
    );
    expect(withProfile.status).toBe(200);

    const stale = harness({
      acknowledge: () => Promise.reject(new LibraryRequestError(409, 'changed')),
    });
    const conflict = await stale.handle(
      jsonRequest('/library/divergence/acks', 'POST', {
        resourceKey: 'skill:gh',
        contentHashes: ['hash-a', 'hash-b'],
      })
    );

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects a mismatched profileId on acknowledgement', async () => {
    const app = harness({
      acknowledge: () =>
        Promise.reject(
          new LibraryRequestError(
            400,
            'Requested profile "work-laptop" does not match the active profile "default".'
          )
        ),
    });

    const response = await app.handle(
      jsonRequest('/library/divergence/acks', 'POST', {
        resourceKey: 'skill:gh',
        contentHashes: ['hash-a', 'hash-b'],
        profileId: 'work-laptop',
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('requires at least two hashes to describe a divergence', async () => {
    const app = harness({ acknowledge: () => Promise.reject(new Error('unreachable')) });

    const response = await app.handle(
      jsonRequest('/library/divergence/acks', 'POST', {
        resourceKey: 'skill:gh',
        contentHashes: ['hash-a'],
      })
    );

    expect(response.status).toBe(422);
  });

  it('forgets an acknowledgement idempotently and validates the key', async () => {
    const forgotten: string[] = [];
    const app = harness({
      forgetAck: (_userId, resourceKey) => {
        forgotten.push(resourceKey);
        return Promise.resolve();
      },
    });

    const removed = await app.handle(jsonRequest('/library/divergence/acks/skill:gh', 'DELETE'));
    const invalid = await app.handle(jsonRequest('/library/divergence/acks/not-a-key', 'DELETE'));

    expect(removed.status).toBe(204);
    expect(invalid.status).toBe(422);
    expect(forgotten).toEqual(['skill:gh']);
  });
});

describe('propagation apply, undo, and backup routes', () => {
  const applyResult = {
    backupId: '2026-07-27T10-00-00.000Z-abc',
    backups: [{ environmentId: 'local', backupId: '2026-07-27T10-00-00.000Z-abc' }],
    partial: false,
    applied: [
      {
        resourceKey: 'skill:gh',
        environmentId: 'local',
        locationId: 'claude-skills' as LibraryLocationId,
        operation: 'create' as const,
        destinationPath: '/home/test/.claude/skills/gh',
        contentHash: 'hash-a',
      },
    ],
    skipped: [],
    failed: [],
  };

  const applyBody = {
    previewToken: 'token',
    stateHash: 'state',
    request: { resourceKeys: ['skill:gh'], targetLocationIds: ['claude-skills'] },
    decisions: [
      {
        resourceKey: 'skill:gh',
        resolution: 'adopt-group',
        winnerContentHash: 'hash-a',
        destinations: [{ locationId: 'claude-skills', action: 'apply' }],
      },
    ],
  };

  it('returns the apply result', async () => {
    const app = harness({ apply: () => Promise.resolve(applyResult) });

    const response = await app.handle(jsonRequest('/library/propagate/apply', 'POST', applyBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(applyResult);
  });

  it('maps a stale preview to 409 so the client re-previews', async () => {
    const app = harness({
      apply: () => Promise.reject(new LibraryRequestError(409, 'The library changed.')),
    });

    const response = await app.handle(jsonRequest('/library/propagate/apply', 'POST', applyBody));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CONFLICT' });
  });

  it('maps an unreviewable decision to 422', async () => {
    const app = harness({
      apply: () => Promise.reject(new LibraryRequestError(422, 'Name the winner.')),
    });

    const response = await app.handle(jsonRequest('/library/propagate/apply', 'POST', applyBody));

    expect(response.status).toBe(422);
  });

  it('rejects an apply with no decisions before reaching the engine', async () => {
    let reached = false;
    const app = harness({
      apply: () => {
        reached = true;
        return Promise.resolve(applyResult);
      },
    });

    const response = await app.handle(
      jsonRequest('/library/propagate/apply', 'POST', { ...applyBody, decisions: [] })
    );

    expect(response.status).toBe(422);
    expect(reached).toBe(false);
  });

  it('undoes an apply by backup id', async () => {
    const undone = {
      backupId: '2026-07-27T10-00-00.000Z-abc',
      // The response names the machine as well as the set: backup ids are minted
      // per store, so a client rendering by id alone would report an undo
      // against the wrong machine's row.
      environmentId: 'local',
      restored: [{ locationId: 'claude-skills' as LibraryLocationId, destinationPath: '/a/gh' }],
      removed: [],
      skipped: [],
    };
    const app = harness({ undo: () => Promise.resolve(undone) });

    const response = await app.handle(
      jsonRequest('/library/propagate/undo', 'POST', { backupId: undone.backupId })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(undone);
  });

  it('reports a backup that retention already discarded as 404', async () => {
    const app = harness({
      undo: () => Promise.reject(new LibraryRequestError(404, 'No such backup.')),
    });

    const response = await app.handle(
      jsonRequest('/library/propagate/undo', 'POST', { backupId: 'gone' })
    );

    expect(response.status).toBe(404);
  });

  it('refuses a backup id that would escape the backup root', async () => {
    let reached = false;
    const app = harness({
      undo: () => {
        reached = true;
        return Promise.reject(new LibraryRequestError(404, 'No such backup.'));
      },
    });

    const response = await app.handle(
      jsonRequest('/library/propagate/undo', 'POST', { backupId: '../../etc/passwd' })
    );

    // Every backup id becomes a path segment under the backup root, so the shape
    // is a request-validation concern and never reaches the store's own guard —
    // which raises a TypeError the route would have to report as a 500.
    expect(response.status).toBe(422);
    expect(reached).toBe(false);
  });

  it('reports what retained backups cost, with the bounds they are trimmed to', async () => {
    const usage = {
      setCount: 3,
      sizeBytes: 4096,
      pinnedSizeBytes: 1024,
      retentionCount: 10,
      retentionBytes: 512 * 1024 * 1024,
      sets: [
        {
          backupId: 'set-1',
          createdAtMs: 1,
          sizeBytes: 1024,
          entryCount: 1,
          pinned: true,
          lastCopyResourceKeys: ['skill:gh'],
          operation: 'removal',
          resourceKeys: ['skill:gh'],
          evictsNext: false,
          manifestReadable: true,
          environmentId: 'local',
          availability: 'available',
        },
      ],
      unreachableEnvironmentIds: [],
    } satisfies PropagationBackupUsage;
    const app = harness({ backupUsage: () => Promise.resolve(usage) });

    const response = await app.handle(jsonRequest('/library/propagate/backups', 'GET'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(usage);
  });
});
