import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  RemovalApplyRequest,
  RemovalPreview,
  RemovalPreviewEntry,
} from '@mangostudio/shared/library';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { applyLibraryRemoval } from '../../../../src/modules/library/application/removal-apply';
import { LibraryRequestError } from '../../../../src/modules/library/domain/library-request-error';
import { hashResourceAt } from '../../../../src/modules/library/infrastructure/instance-reader';
import { refuseLibraryRemove } from '../../../support/mocks/refusing-library-runtime';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mango-removal-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function env(): PathEnv {
  return { homeDir: home, platform: 'linux', env: {} };
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

/**
 * Drives the Hub's planning and guards only. Every case here is refused before
 * a machine is written; the writes themselves run against the real runtime in
 * `rust-runtime-library-removal.integration.test.ts`.
 */
function apply(preview: RemovalPreview, request: RemovalApplyRequest) {
  return applyLibraryRemoval('user-1', request, {
    preview: () => Promise.resolve(preview),
    pathEnv: env,
    runtimeRemove: refuseLibraryRemove,
  });
}

describe('applyLibraryRemoval', () => {
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
        runtimeRemove: () => Promise.reject(new Error('transport died')),
        resetCaches: (rows) => {
          for (const row of rows) reset.push(row.environmentId);
        },
      })
    ).rejects.toThrow('transport died');

    expect(reset).toEqual(['local']);
  });

  // The Hub half of a failed manifest write: the runtime reports the set but
  // could not record it (`removal_tests.rs` "withholds_a_handle_undo_could_not_resolve"
  // pins that answer), so no handle comes back and the row carries the only
  // pointer to the copies.
  it('withholds a backup id the runtime could not record, keeping the pointer in the failure', async () => {
    seedSkill(SKILL_LOCATION_ROOTS['claude-skills'], 'one');
    const preview = previewOf([await entryFor(['claude-skills'])]);
    const message =
      'Could not record the backup manifest, so this removal cannot be undone automatically; the copies are under backup set "2026-07-28T10-00-00.000Z-fixed": no space left on device';

    const result = await applyLibraryRemoval(
      'user-1',
      requestFor(preview, { acknowledgeLastCopy: ['skill:gh'] }),
      {
        preview: () => Promise.resolve(preview),
        pathEnv: env,
        recordBackup: () => Promise.reject(new Error('expected no backup to be recorded')),
        runtimeRemove: (params) =>
          Promise.resolve({
            partial: true,
            removed: [
              {
                resourceKey: 'skill:gh',
                environmentId: 'local',
                locationId: 'claude-skills',
                path: params.operations[0]?.expectedPath ?? '',
                contentHash: params.operations[0]?.expectedContentHash ?? '',
                lastCopy: true,
              },
            ],
            kept: [],
            failed: [
              {
                resourceKey: 'skill:gh',
                environmentId: 'local',
                locationId: 'claude-skills',
                reason: 'remove-failed',
                message,
              },
            ],
            backups: [],
          }),
      }
    );

    expect({ partial: result.partial, backupId: result.backupId }).toEqual({
      partial: true,
      backupId: undefined,
    });
    expect(result.failed[0]?.message).toContain('2026-07-28T10-00-00.000Z-fixed');
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
});

describe('applyLibraryRemoval preview binding', () => {
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
  Removal across machines: the refusals the Hub makes before any machine is
  written. The writes themselves run against real runtimes in
  `rust-runtime-library-removal.integration.test.ts`.
*/
describe('applyLibraryRemoval across machines', () => {
  let remoteHome: string;

  beforeEach(() => {
    remoteHome = mkdtempSync(join(tmpdir(), 'mango-removal-remote-'));
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

  function crossMachineApply(preview: RemovalPreview, request: RemovalApplyRequest) {
    return applyLibraryRemoval('user-1', request, {
      preview: () => Promise.resolve(preview),
      pathEnv: envFor,
      runtimeRemove: refuseLibraryRemove,
      recordBackup: () => Promise.resolve(),
    });
  }

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
});
