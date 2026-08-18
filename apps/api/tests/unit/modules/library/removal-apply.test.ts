import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  RemovalApplyRequest,
  RemovalPreview,
  RemovalPreviewEntry,
} from '@mangostudio/shared/library';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { undoLibraryPropagation } from '../../../../src/modules/library/application/propagation-apply';
import { applyLibraryRemoval } from '../../../../src/modules/library/application/removal-apply';
import { LibraryRequestError } from '../../../../src/modules/library/domain/library-request-error';
import {
  type BackupStoreDeps,
  defaultBackupStoreDeps,
  readBackupManifest,
} from '../../../../src/modules/library/infrastructure/backup-store';
import { hashResourceAt } from '../../../../src/modules/library/infrastructure/instance-reader';
import {
  nodeTreeRemovalFs,
  type TreeRemovalFs,
} from '../../../../src/modules/library/infrastructure/tree-removal';

let home: string;
let backupRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mango-removal-'));
  backupRoot = join(home, 'backups');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function env(): PathEnv {
  return { homeDir: home, platform: 'linux', env: {} };
}

function backupDeps(overrides: Partial<BackupStoreDeps> = {}): BackupStoreDeps {
  return {
    ...defaultBackupStoreDeps,
    backupDir: () => backupRoot,
    retentionCount: () => 10,
    retentionBytes: () => 1024 ** 3,
    now: () => new Date('2026-07-28T10:00:00.000Z'),
    randomSuffix: () => 'fixed',
    ...overrides,
  };
}

/** Writes a skill tree the way a real location holds one. */
function seedSkill(locationRoot: string, body: string, slug = 'gh'): string {
  const path = join(home, locationRoot, slug);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), `---\nname: ${slug}\ndescription: d\n---\n${body}\n`);
  writeFileSync(join(path, 'reference.md'), 'reference\n');
  return path;
}

const SKILL_LOCATION_ROOTS = {
  'claude-skills': '.claude/skills',
  'mango-skills': '.mango/skills',
  'agents-skills': '.agents/skills',
  'codex-skills': '.codex/skills',
} as const;

type SkillLocationId = keyof typeof SKILL_LOCATION_ROOTS;

async function entryFor(
  locationIds: readonly SkillLocationId[],
  slug = 'gh'
): Promise<RemovalPreviewEntry> {
  const locations = await Promise.all(
    locationIds.map(async (locationId) => {
      const path = join(home, SKILL_LOCATION_ROOTS[locationId], slug);
      return {
        environmentId: 'local',
        locationId,
        targetIds: [],
        operation: 'remove' as const,
        path,
        contentHash: await hashResourceAt(path, 'directory'),
        modifiedAtMs: 1,
        eliminatesContentGroup: false,
      };
    })
  );

  return {
    resourceKey: `skill:${slug}`,
    ref: { kind: 'skill', slug },
    divergence: 'uniform',
    locations,
    instancePlacements: locationIds.map((locationId) => ({
      environmentId: 'local',
      locationId,
    })),
    wouldRemoveLastCopy: true,
  };
}

function previewOf(entries: RemovalPreviewEntry[]): RemovalPreview {
  return {
    previewToken: 'token',
    stateHash: 'state',
    entries,
    staleStagedRemovals: [],
  };
}

function requestFor(
  preview: RemovalPreview,
  options: { readonly acknowledgeLastCopy?: string[]; readonly keep?: readonly string[] } = {}
): RemovalApplyRequest {
  const keep = new Set(options.keep ?? []);
  return {
    previewToken: preview.previewToken,
    stateHash: preview.stateHash,
    request: {
      resourceKeys: preview.entries.map((entry) => entry.resourceKey),
      locationIds: preview.entries.flatMap((entry) =>
        entry.locations.map((location) => location.locationId)
      ),
    },
    decisions: preview.entries.map((entry) => ({
      resourceKey: entry.resourceKey,
      locations: entry.locations.map((location) => ({
        environmentId: location.environmentId,
        locationId: location.locationId,
        action: keep.has(location.locationId) ? ('keep' as const) : ('remove' as const),
      })),
    })),
    acknowledgeLastCopy: options.acknowledgeLastCopy ?? [],
  };
}

function apply(
  preview: RemovalPreview,
  request: RemovalApplyRequest,
  overrides: { readonly treeFs?: TreeRemovalFs; readonly backup?: BackupStoreDeps } = {}
) {
  return applyLibraryRemoval('user-1', request, {
    preview: () => Promise.resolve(preview),
    pathEnv: env,
    writeEngine: 'in-process',
    backup: overrides.backup ?? backupDeps(),
    ...(overrides.treeFs && { treeFs: overrides.treeFs }),
  });
}

describe('applyLibraryRemoval', () => {
  it('removes a skill tree, backs it up, and hands back the undo handle', async () => {
    const path = seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);

    const result = await apply(preview, requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }));

    expect(result.partial).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].lastCopy).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(result.backupId).toBeDefined();
  });

  it('drops location caches for every targeted machine when the engine throws', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);
    const reset: string[] = [];

    // A transport failure is not proof that nothing was deleted: machines are
    // written one after another, so an earlier one can already be missing
    // copies while a later one fails. Invalidating anyway costs a rescan;
    // skipping it reports the pre-removal matrix as current for the whole TTL.
    await expect(
      applyLibraryRemoval('user-1', requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }), {
        preview: () => Promise.resolve(preview),
        pathEnv: env,
        writeEngine: 'runtime',
        runtimeRemove: () => Promise.reject(new Error('transport died')),
        resetCaches: (rows) => {
          for (const row of rows) reset.push(row.environmentId);
        },
      })
    ).rejects.toThrow('transport died');

    expect(reset).toEqual(['local']);
  });

  it('leaves no staged temp tree beside the destination once it commits', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);

    await apply(preview, requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }));

    const locationRoot = join(home, SKILL_LOCATION_ROOTS['claude-skills']);
    expect(existsSync(join(locationRoot, '.gh.fixed.removing'))).toBe(false);
  });

  it('restores a removed resource byte-identically through the shared undo route', async () => {
    const path = seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const before = await hashResourceAt(path, 'directory');
    const preview = previewOf([await entryFor(['claude-skills'])]);
    const backup = backupDeps();

    const result = await apply(
      preview,
      requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }),
      { backup }
    );
    const undone = await undoLibraryPropagation(result.backupId ?? '', {
      backup,
      pathEnv: env,
      writeEngine: 'in-process',
    });

    expect(undone.restored).toHaveLength(1);
    expect(await hashResourceAt(path, 'directory')).toBe(before);
    expect(readFileSync(join(path, 'reference.md'), 'utf8')).toBe('reference\n');
  });

  it('pins the backup set when it holds the last copy of a resource', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);
    const backup = backupDeps();

    const result = await apply(
      preview,
      requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }),
      { backup }
    );
    const manifest = await readBackupManifest(result.backupId ?? '', backup);

    expect(manifest?.pinned).toBe(true);
    expect(manifest?.lastCopyResourceKeys).toEqual(['skill:gh']);
  });

  // Every entry a removal writes carries a backup, so undoing this set only
  // ever puts content back. Recording that is what lets a listed row commit to
  // "put the removed copies back" instead of a neutral verb.
  it('records the flow that wrote the set, and what the set holds', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    seedSkill(SKILL_LOCATION_ROOTS['mango-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills', 'mango-skills'])]);
    const backup = backupDeps();

    const result = await apply(preview, requestFor(preview, { keep: ['mango-skills'] }), {
      backup,
    });
    const manifest = await readBackupManifest(result.backupId ?? '', backup);

    expect(manifest?.operation).toBe('removal');
    expect(manifest?.entries.map((entry) => entry.resourceKey)).toEqual(['skill:gh']);
  });

  it('does not pin an ordinary removal that leaves copies behind', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    seedSkill(SKILL_LOCATION_ROOTS['mango-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills', 'mango-skills'])]);
    const backup = backupDeps();

    const result = await apply(preview, requestFor(preview, { keep: ['mango-skills'] }), {
      backup,
    });
    const manifest = await readBackupManifest(result.backupId ?? '', backup);

    expect(result.failed).toEqual([]);
    expect(manifest?.pinned).toBeUndefined();
  });
});

describe('applyLibraryRemoval last-copy guard', () => {
  it('refuses an apply that would zero a resource without an acknowledgement', async () => {
    const path = seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);

    const failure = await apply(preview, requestFor(preview)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LibraryRequestError);
    expect((failure as LibraryRequestError).status).toBe(422);
    expect((failure as LibraryRequestError).code).toBe(ERROR_CODES.LAST_COPY_UNACKNOWLEDGED);
    expect(existsSync(path)).toBe(true);
  });

  it('is not satisfied by an acknowledgement naming a different resource', async () => {
    const gh = seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    seedSkill(SKILL_LOCATION_ROOTS['mango-skills'], 'two', 'jq');
    const preview = previewOf([
      await entryFor(['claude-skills']),
      await entryFor(['mango-skills'], 'jq'),
    ]);

    const failure = await apply(
      preview,
      requestFor(preview, { acknowledgeLastCopy: ['skill:jq'] })
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LibraryRequestError);
    expect((failure as LibraryRequestError).code).toBe(ERROR_CODES.LAST_COPY_UNACKNOWLEDGED);
    expect(existsSync(gh)).toBe(true);
  });

  it('rejects an acknowledgement for a resource this removal is not touching', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);

    await expect(
      apply(preview, requestFor(preview, { acknowledgeLastCopy: ['skill:unrelated'] }))
    ).rejects.toBeInstanceOf(LibraryRequestError);
  });

  it('needs no acknowledgement while a copy survives somewhere', async () => {
    const claude = seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    seedSkill(SKILL_LOCATION_ROOTS['mango-skills'], 'one');
    seedSkill(SKILL_LOCATION_ROOTS['agents-skills'], 'one');
    seedSkill(SKILL_LOCATION_ROOTS['codex-skills'], 'one');
    const preview = previewOf([
      await entryFor(['claude-skills', 'mango-skills', 'agents-skills', 'codex-skills']),
    ]);

    const result = await apply(preview, requestFor(preview, { keep: ['codex-skills'] }));

    expect(result.failed).toEqual([]);
    expect(result.removed).toHaveLength(3);
    expect(existsSync(claude)).toBe(false);
    expect(existsSync(join(home, SKILL_LOCATION_ROOTS['codex-skills'], 'gh'))).toBe(true);
  });
});

describe('applyLibraryRemoval atomicity', () => {
  it('leaves every tree byte-identical when one removal in the middle fails', async () => {
    const paths = (['claude-skills', 'mango-skills', 'agents-skills'] as const).map((locationId) =>
      seedSkill(SKILL_LOCATION_ROOTS[locationId], 'one')
    );
    const before = await Promise.all(paths.map((path) => hashResourceAt(path, 'directory')));
    const preview = previewOf([await entryFor(['claude-skills', 'mango-skills', 'agents-skills'])]);

    let renames = 0;
    const treeFs: TreeRemovalFs = {
      ...nodeTreeRemovalFs,
      rename(source, destination) {
        renames += 1;
        if (renames === 3) return Promise.reject(new Error('disk went away'));
        return nodeTreeRemovalFs.rename(source, destination);
      },
    };

    const result = await apply(
      preview,
      requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }),
      { treeFs }
    );

    expect(result.partial).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(await Promise.all(paths.map((path) => hashResourceAt(path, 'directory')))).toEqual(
      before
    );
  });

  it('reports only the copies whose compensation also failed as removed', async () => {
    const order = ['agents-skills', 'claude-skills', 'mango-skills'] as const;
    const paths = Object.fromEntries(
      order.map((locationId) => [locationId, seedSkill(SKILL_LOCATION_ROOTS[locationId], 'one')])
    );
    const preview = previewOf([await entryFor(order)]);

    // Renames 1 and 2 stage agents and claude, 3 fails the apply, 4 puts claude
    // back, and 5 fails to put agents back. Only agents is really gone.
    let renames = 0;
    const treeFs: TreeRemovalFs = {
      ...nodeTreeRemovalFs,
      rename(source, destination) {
        renames += 1;
        if (renames === 3 || renames === 5) return Promise.reject(new Error('disk went away'));
        return nodeTreeRemovalFs.rename(source, destination);
      },
    };

    const result = await apply(
      preview,
      requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }),
      { treeFs }
    );

    expect(result.partial).toBe(true);
    // Listing claude here would send the caller to restore a tree that is
    // sitting exactly where they left it.
    expect(result.removed.map((row) => row.locationId)).toEqual(['agents-skills']);
    expect(existsSync(paths['claude-skills'])).toBe(true);
    expect(existsSync(paths['agents-skills'])).toBe(false);
    expect(result.failed.map((row) => row.locationId)).toEqual(['mango-skills']);
  });

  it('withholds a backup id the undo route could not resolve', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);

    // Rename 1 stages the tree, the manifest write then fails, and rename 2 —
    // putting the tree back — fails too. The copy is gone and nothing on disk
    // says where it went.
    let renames = 0;
    const treeFs: TreeRemovalFs = {
      ...nodeTreeRemovalFs,
      rename(source, destination) {
        renames += 1;
        if (renames === 2) return Promise.reject(new Error('disk went away'));
        return nodeTreeRemovalFs.rename(source, destination);
      },
    };
    const backup = backupDeps({
      fs: {
        ...defaultBackupStoreDeps.fs,
        writeFile: () => Promise.reject(new Error('no space left on device')),
      },
    });

    const result = await apply(
      preview,
      requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }),
      { treeFs, backup }
    );

    expect(result.partial).toBe(true);
    expect(result.removed).toHaveLength(1);
    // `undo` resolves a manifest and answers 404 without one, so returning the
    // id would put a restore button on screen that cannot work.
    expect(result.backupId).toBeUndefined();
    // It still has to reach the user, because the backup set is the only copy.
    expect(result.failed[0]?.message).toContain('2026-07-28T10-00-00.000Z-fixed');
  });

  it('accounts for every reviewed location when the apply stops at a failure', async () => {
    const order = ['agents-skills', 'claude-skills', 'mango-skills', 'codex-skills'] as const;
    for (const locationId of order) seedSkill(SKILL_LOCATION_ROOTS[locationId], 'one');
    const preview = previewOf([await entryFor(order)]);

    // Rename 1 stages agents, rename 2 fails on claude, and mango and codex are
    // never reached. Rename 3 puts agents back, so nothing ends up removed.
    let renames = 0;
    const treeFs: TreeRemovalFs = {
      ...nodeTreeRemovalFs,
      rename(source, destination) {
        renames += 1;
        if (renames === 2) return Promise.reject(new Error('disk went away'));
        return nodeTreeRemovalFs.rename(source, destination);
      },
    };

    const result = await apply(
      preview,
      requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }),
      { treeFs }
    );

    expect(result.partial).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.failed.map((row) => row.locationId)).toEqual(['claude-skills']);
    // Without these the response would simply omit three of the four locations
    // the user reviewed, and the panel would show a failure with no account of
    // what happened to everything else.
    expect(
      result.kept.map((row) => [row.locationId, row.reason]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    ).toEqual([
      ['agents-skills', 'rolled-back'],
      ['codex-skills', 'not-attempted'],
      ['mango-skills', 'not-attempted'],
    ]);
  });

  it('fails and rolls back when a destination survives its own removal', async () => {
    const path = seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);

    // A rename that reports success while the destination still resolves is the
    // case post-removal verification exists to catch.
    const treeFs: TreeRemovalFs = {
      ...nodeTreeRemovalFs,
      rename: () => Promise.resolve(),
    };

    const result = await apply(
      preview,
      requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }),
      { treeFs }
    );

    expect(result.failed[0]?.reason).toBe('verification-failed');
    expect(result.partial).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('refuses to remove a copy whose bytes changed since the preview', async () => {
    const path = seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);
    writeFileSync(join(path, 'SKILL.md'), 'edited after previewing\n');

    const result = await apply(preview, requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }));

    expect(result.failed[0]?.reason).toBe('guard-rejected');
    expect(existsSync(path)).toBe(true);
  });

  it('rejects an apply bound to a preview the disk has moved past', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);
    const request = requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] });

    await expect(apply({ ...preview, stateHash: 'moved-on' }, request)).rejects.toBeInstanceOf(
      LibraryRequestError
    );
  });

  it('refuses to remove from a location the preview did not classify removable', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const entry = await entryFor(['claude-skills']);
    const preview = previewOf([
      {
        ...entry,
        locations: entry.locations.map((location) => ({
          ...location,
          operation: 'blocked' as const,
          blockedReason: 'invalid-instance' as const,
        })),
      },
    ]);

    await expect(
      apply(preview, requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }))
    ).rejects.toBeInstanceOf(LibraryRequestError);
  });

  it('refuses an apply that leaves an offered location undecided', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    seedSkill(SKILL_LOCATION_ROOTS['mango-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills', 'mango-skills'])]);
    const request = requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] });

    await expect(
      apply(preview, {
        ...request,
        decisions: [{ resourceKey: 'skill:gh', locations: [request.decisions[0].locations[0]] }],
      })
    ).rejects.toBeInstanceOf(LibraryRequestError);
  });
});

/*
  Removal across machines, driven in process against two temp homes.

  The two things that must hold are the ones a single-machine engine cannot
  check for itself: copies go from the machine the preview named, and each
  machine's backup — the only remaining copy of what it deleted — lands on its
  own disk with its own handle.
*/
describe('applyLibraryRemoval across machines', () => {
  let remoteHome: string;
  let remoteBackupRoot: string;

  beforeEach(() => {
    remoteHome = mkdtempSync(join(tmpdir(), 'mango-removal-remote-'));
    remoteBackupRoot = join(remoteHome, 'backups');
  });

  afterEach(() => {
    rmSync(remoteHome, { recursive: true, force: true });
  });

  const homeOf = (environmentId: string) => (environmentId === 'local' ? home : remoteHome);

  function envFor(environmentId: string) {
    return { homeDir: homeOf(environmentId), platform: 'linux' as const, env: {} };
  }

  function seedOn(environmentId: string, locationId: SkillLocationId, body: string): string {
    const path = join(homeOf(environmentId), SKILL_LOCATION_ROOTS[locationId], 'gh');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'SKILL.md'), `---\nname: gh\ndescription: d\n---\n${body}\n`);
    return path;
  }

  async function locationOn(
    environmentId: string,
    locationId: SkillLocationId
  ): Promise<RemovalPreviewEntry['locations'][number]> {
    const path = join(homeOf(environmentId), SKILL_LOCATION_ROOTS[locationId], 'gh');
    return {
      environmentId,
      locationId,
      targetIds: [],
      operation: 'remove' as const,
      path,
      contentHash: await hashResourceAt(path, 'directory'),
      modifiedAtMs: 1,
      eliminatesContentGroup: false,
    };
  }

  function backupRootFor(environmentId: string): string {
    return environmentId === 'local' ? backupRoot : remoteBackupRoot;
  }

  /** Follows the batch currently running, the way a real per-machine store does. */
  let currentEnvironmentId = 'local';

  function crossMachineApply(preview: RemovalPreview, request: RemovalApplyRequest) {
    return applyLibraryRemoval('user-1', request, {
      preview: () => Promise.resolve(preview),
      pathEnv: (environmentId) => {
        currentEnvironmentId = environmentId;
        return envFor(environmentId);
      },
      writeEngine: 'in-process',
      backup: {
        ...backupDeps(),
        backupDir: () => backupRootFor(currentEnvironmentId),
      },
      recordBackup: () => Promise.resolve(),
    });
  }

  it('removes each copy from the machine the preview named', async () => {
    const localPath = seedOn('local', 'claude-skills', 'local');
    const remotePath = seedOn('remote-box', 'claude-skills', 'remote');
    const preview = previewOf([
      {
        resourceKey: 'skill:gh',
        ref: { kind: 'skill', slug: 'gh' },
        divergence: 'divergent',
        locations: [
          await locationOn('local', 'claude-skills'),
          await locationOn('remote-box', 'claude-skills'),
        ],
        instancePlacements: [
          { environmentId: 'local', locationId: 'claude-skills' },
          { environmentId: 'remote-box', locationId: 'claude-skills' },
        ],
        wouldRemoveLastCopy: true,
      },
    ]);

    const result = await crossMachineApply(
      preview,
      requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] })
    );

    expect(result.failed).toEqual([]);
    expect(result.removed.map((row) => row.environmentId).sort()).toEqual(['local', 'remote-box']);
    expect(existsSync(localPath)).toBe(false);
    expect(existsSync(remotePath)).toBe(false);
    // One irreplaceable set per machine, each on its own disk. A single handle
    // would restore half of what was lost while looking like it restored all.
    expect(result.backups.map((handle) => handle.environmentId).sort()).toEqual([
      'local',
      'remote-box',
    ]);
    expect(result.backupId).toBeUndefined();
    expect(existsSync(remoteBackupRoot)).toBe(true);
  });

  it('leaves the other machine alone when only one is selected', async () => {
    const localPath = seedOn('local', 'claude-skills', 'local');
    const remotePath = seedOn('remote-box', 'claude-skills', 'remote');
    const preview = previewOf([
      {
        resourceKey: 'skill:gh',
        ref: { kind: 'skill', slug: 'gh' },
        divergence: 'divergent',
        locations: [
          await locationOn('local', 'claude-skills'),
          await locationOn('remote-box', 'claude-skills'),
        ],
        instancePlacements: [
          { environmentId: 'local', locationId: 'claude-skills' },
          { environmentId: 'remote-box', locationId: 'claude-skills' },
        ],
        wouldRemoveLastCopy: false,
      },
    ]);
    const request: RemovalApplyRequest = {
      previewToken: preview.previewToken,
      stateHash: preview.stateHash,
      request: { resourceKeys: ['skill:gh'], locationIds: ['claude-skills'] },
      decisions: [
        {
          resourceKey: 'skill:gh',
          locations: [
            { environmentId: 'local', locationId: 'claude-skills', action: 'remove' },
            { environmentId: 'remote-box', locationId: 'claude-skills', action: 'keep' },
          ],
        },
      ],
      // No acknowledgement needed and none given: a copy survives on the other
      // machine, so this is not a last-copy removal.
      acknowledgeLastCopy: [],
    };

    const result = await crossMachineApply(preview, request);

    expect(result.failed).toEqual([]);
    expect(existsSync(localPath)).toBe(false);
    expect(existsSync(remotePath)).toBe(true);
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0].environmentId).toBe('local');
  });

  it('refuses to zero a resource across machines without an acknowledgement', async () => {
    seedOn('local', 'claude-skills', 'local');
    seedOn('remote-box', 'claude-skills', 'remote');
    const preview = previewOf([
      {
        resourceKey: 'skill:gh',
        ref: { kind: 'skill', slug: 'gh' },
        divergence: 'divergent',
        locations: [
          await locationOn('local', 'claude-skills'),
          await locationOn('remote-box', 'claude-skills'),
        ],
        instancePlacements: [
          { environmentId: 'local', locationId: 'claude-skills' },
          { environmentId: 'remote-box', locationId: 'claude-skills' },
        ],
        wouldRemoveLastCopy: true,
      },
    ]);

    // Removing every machine's copy is exactly the case the guard exists for,
    // and it does not stop being one because the copies are on two disks.
    await expect(crossMachineApply(preview, requestFor(preview))).rejects.toMatchObject({
      status: 422,
    });
  });

  it('reports the machine a mid-run failure never reached', async () => {
    const thirdHome = mkdtempSync(join(tmpdir(), 'mango-removal-third-'));
    const thirdBackupRoot = join(thirdHome, 'backups');
    try {
      const homes: Record<string, string> = {
        local: home,
        'remote-box': remoteHome,
        'third-box': thirdHome,
      };
      const seed = (environmentId: string) => {
        const path = join(homes[environmentId], SKILL_LOCATION_ROOTS['claude-skills'], 'gh');
        mkdirSync(path, { recursive: true });
        writeFileSync(
          join(path, 'SKILL.md'),
          `---\nname: gh\ndescription: d\n---\n${environmentId}\n`
        );
        return path;
      };
      const localPath = seed('local');
      const remotePath = seed('remote-box');
      const thirdPath = seed('third-box');

      const location = async (environmentId: string, contentHash?: string) => ({
        environmentId,
        locationId: 'claude-skills' as const,
        targetIds: [],
        operation: 'remove' as const,
        path: join(homes[environmentId], SKILL_LOCATION_ROOTS['claude-skills'], 'gh'),
        contentHash:
          contentHash ??
          (await hashResourceAt(
            join(homes[environmentId], SKILL_LOCATION_ROOTS['claude-skills'], 'gh'),
            'directory'
          )),
        modifiedAtMs: 1,
        eliminatesContentGroup: false,
      });

      const preview = previewOf([
        {
          resourceKey: 'skill:gh',
          ref: { kind: 'skill', slug: 'gh' },
          divergence: 'divergent',
          locations: [
            await location('local'),
            // A hash the disk no longer holds: this machine's batch fails its
            // own guard check, and the run stops before reaching the next one.
            await location('remote-box', 'stale-hash'),
            await location('third-box'),
          ],
          instancePlacements: [
            { environmentId: 'local', locationId: 'claude-skills' },
            { environmentId: 'remote-box', locationId: 'claude-skills' },
            { environmentId: 'third-box', locationId: 'claude-skills' },
          ],
          wouldRemoveLastCopy: true,
        },
      ]);

      let currentEnvironmentId = 'local';
      const result = await applyLibraryRemoval(
        'user-1',
        requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }),
        {
          preview: () => Promise.resolve(preview),
          pathEnv: (environmentId) => {
            currentEnvironmentId = environmentId;
            return { homeDir: homes[environmentId], platform: 'linux', env: {} };
          },
          writeEngine: 'in-process',
          backup: {
            ...backupDeps(),
            backupDir: () =>
              currentEnvironmentId === 'local'
                ? backupRoot
                : currentEnvironmentId === 'remote-box'
                  ? remoteBackupRoot
                  : thirdBackupRoot,
          },
          recordBackup: () => Promise.resolve(),
        }
      );

      expect(result.failed.map((row) => row.environmentId)).toEqual(['remote-box']);
      // Local already committed before the failure; third-box was never
      // reached — neither is something a cross-machine rollback undoes.
      expect(existsSync(localPath)).toBe(false);
      expect(existsSync(remotePath)).toBe(true);
      expect(existsSync(thirdPath)).toBe(true);

      // Without this, third-box's placement would appear in no result array at
      // all — offered by the preview, decided by the user, and never mentioned.
      const thirdBoxKept = result.kept.find((row) => row.environmentId === 'third-box');
      expect(thirdBoxKept?.reason).toBe('not-attempted');
      expect(thirdBoxKept?.locationId).toBe('claude-skills');
    } finally {
      rmSync(thirdHome, { recursive: true, force: true });
    }
  });
});
