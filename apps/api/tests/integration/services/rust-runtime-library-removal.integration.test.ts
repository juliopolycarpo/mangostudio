/**
 * The Hub's library removal, and its undo through the shared route, driven
 * through the production protocol path against the compiled Rust runtime.
 *
 * These cases used to run the TypeScript removal engine inside the Hub
 * (`writeEngine: 'in-process'`) with a rename-counting `TreeRemovalFs`. Here
 * the real `serve` binary stages, backs up, verifies and compensates, and each
 * preview is the Hub's production scan of the box. Failure cases use
 * `tamperingRemove`: the Hub's batch reaches the real runtime with one
 * operation's expected hash rewritten, so that copy fails the runtime's guard
 * after the earlier copies were already staged aside — and the runtime must put
 * them back. Cross-machine cases rewrite the Hub's own preview instead, which
 * is the input the Hub turns into each machine's batch.
 *
 * | Former in-process case | Replacement here | Fault seam |
 * | --- | --- | --- |
 * | `removal-apply.test.ts` removes a skill tree, backs it up, and hands back the undo handle | same name | none |
 * | … leaves no staged temp tree beside the destination once it commits | same name | none |
 * | … restores a removed resource byte-identically through the shared undo route | same name | none |
 * | … pins the backup set when it holds the last copy of a resource | same name | none |
 * | … records the flow that wrote the set, and what the set holds | same name | none |
 * | … does not pin an ordinary removal that leaves copies behind | same name | none |
 * | … needs no acknowledgement while a copy survives somewhere | same name | none |
 * | … leaves every tree byte-identical when one removal in the middle fails | same name | third operation's expected hash tampered |
 * | … accounts for every reviewed location when the apply stops at a failure | same name | second of four operations tampered |
 * | … refuses to remove a copy whose bytes changed since the preview | same name | sole operation tampered (the runtime guard) |
 * | … removes each copy from the machine the preview named | same name | none; two boxes |
 * | … leaves the other machine alone when only one is selected | same name | none; two boxes |
 * | … reports the machine a mid-run failure never reached | same name | second machine's previewed hash rewritten; three boxes |
 * | `library-removal.integration.test.ts` removes every copy, then restores them all through the shared undo route | same name | none |
 * | … resolves a divergence by removing the copy the user does not want | same name | none |
 * | … POST /library/removal/apply removes the last copy once the request acknowledges it | same name | none |
 *
 * Kept on the Rust unit seam (`MutationFs`), because no input from outside the
 * runtime process can make a rename fail on command: compensation that itself
 * fails, a destination that survives its own removal, and a manifest write that
 * fails — see `removal_tests.rs`. The Hub half of the last one (withholding the
 * handle) is pinned in `removal-apply.test.ts`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  LibraryLocationId,
  RemovalApply,
  RemovalApplyRequest,
  RemovalPreview,
  RemovalPreviewRequest,
} from '@mangostudio/shared/library';
import {
  createBackupStoreDeps,
  hashResourceAt,
  readBackupManifest,
} from '@mangostudio/shared/library/machine';
import { undoLibraryPropagation } from '../../../src/modules/library/application/propagation-apply';
import {
  applyLibraryRemoval,
  type RemovalApplyDeps,
} from '../../../src/modules/library/application/removal-apply';
import { previewLibraryRemoval } from '../../../src/modules/library/application/removal-preview';
import { createRemovalRoutes } from '../../../src/modules/library/http/removal-routes';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  type LibraryBox,
  type LibraryFleet,
  openLibraryFleet,
  tamperingRemove,
} from '../../support/rust-library-boxes';
import { resolveRustRuntimeBinary } from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();
const TIMEOUT_MS = 60_000;
const USER = {
  id: 'rust-library-removal-user',
  name: 'Rust Library Removal User',
  email: 'rust-library-removal@mangostudio.test',
};
const BOX = 'rust-removal-box';
const REMOTE = 'rust-removal-remote';
const THIRD = 'rust-removal-third';

const SKILL_LOCATIONS: readonly LibraryLocationId[] = [
  'agents-skills',
  'claude-skills',
  'cursor-skills',
  'mango-skills',
];
const SKILL_DIRECTORIES: Record<string, readonly string[]> = {
  'mango-skills': ['.mango', 'skills'],
  'agents-skills': ['.agents', 'skills'],
  'claude-skills': ['.claude', 'skills'],
  'cursor-skills': ['.cursor', 'skills'],
};

let fleet: LibraryFleet | undefined;
let restoreAuth: (() => void) | undefined;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = undefined;
  await fleet?.dispose();
  fleet = undefined;
});

async function openBox(): Promise<{ fleet: LibraryFleet; box: LibraryBox }> {
  fleet = await openLibraryFleet(binary, USER);
  const box = await fleet.addBox(BOX);
  fleet.enableHomeLocations(SKILL_LOCATIONS);
  return { fleet, box };
}

function skillDir(box: LibraryBox, locationId: LibraryLocationId): string {
  return join(box.home, ...(SKILL_DIRECTORIES[locationId] ?? []), 'gh');
}

/** A skill tree the way a real location holds one: a body and a sibling file. */
function seedSkill(box: LibraryBox, locationId: LibraryLocationId, body: string): string {
  const path = skillDir(box, locationId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), `---\nname: gh\ndescription: d\n---\n${body}\n`);
  writeFileSync(join(path, 'reference.md'), 'reference\n');
  return path;
}

/** The presence map `present` answers when every skill location agrees. */
function everywhere(value: boolean): Record<string, boolean> {
  return Object.fromEntries(SKILL_LOCATIONS.map((id) => [id, value]));
}

/** Which of the given locations still hold the skill, as a readable map. */
function present(
  box: LibraryBox,
  locationIds: readonly LibraryLocationId[]
): Record<string, boolean> {
  return Object.fromEntries(locationIds.map((id) => [id, existsSync(skillDir(box, id))]));
}

async function treeHashes(paths: readonly string[]): Promise<string[]> {
  return await Promise.all(
    paths.map((path) => (existsSync(path) ? hashResourceAt(path, 'directory') : '<absent>'))
  );
}

function previewRemoval(
  locationIds: readonly LibraryLocationId[],
  environmentIds: readonly string[] = [BOX]
): Promise<RemovalPreview> {
  const request: RemovalPreviewRequest = {
    resourceKeys: ['skill:gh'],
    locationIds: [...locationIds],
    environmentIds: [...environmentIds],
  };
  return previewLibraryRemoval(USER.id, request);
}

function requestFor(
  preview: RemovalPreview,
  options: {
    readonly acknowledge?: boolean;
    readonly keep?: (environmentId: string, locationId: string) => boolean;
  } = {}
): RemovalApplyRequest {
  const entries = preview.entries;
  return {
    previewToken: preview.previewToken,
    stateHash: preview.stateHash,
    request: {
      resourceKeys: entries.map((entry) => entry.resourceKey),
      locationIds: [
        ...new Set(entries.flatMap((entry) => entry.locations.map((l) => l.locationId))),
      ],
      environmentIds: [
        ...new Set(entries.flatMap((entry) => entry.locations.map((l) => l.environmentId))),
      ],
    },
    decisions: entries.map((entry) => ({
      resourceKey: entry.resourceKey,
      locations: entry.locations.map((location) => ({
        environmentId: location.environmentId,
        locationId: location.locationId,
        action:
          location.operation === 'remove' &&
          !options.keep?.(location.environmentId, location.locationId)
            ? ('remove' as const)
            : ('keep' as const),
      })),
    })),
    acknowledgeLastCopy: options.acknowledge ? ['skill:gh'] : [],
  };
}

function remove(
  request: RemovalApplyRequest,
  deps: Partial<RemovalApplyDeps> = {}
): Promise<RemovalApply> {
  return applyLibraryRemoval(USER.id, request, deps);
}

/** Fails the runtime's guard for the operation at `index`. */
function failingAt(target: LibraryFleet, index: number): Partial<RemovalApplyDeps> {
  return {
    runtimeRemove: tamperingRemove(target, (operation, at) =>
      at === index ? { ...operation, expectedContentHash: 'tampered' } : operation
    ),
  };
}

function manifestOf(box: LibraryBox, backupId: string | undefined) {
  return readBackupManifest(backupId ?? '', createBackupStoreDeps({ backupRoot: box.backupRoot }));
}

describe('Rust runtime removal', () => {
  it.skipIf(!binary.available)(
    'removes a skill tree, backs it up, and hands back the undo handle',
    async () => {
      const { box } = await openBox();
      const path = seedSkill(box, 'claude-skills', 'one');

      const result = await remove(
        requestFor(await previewRemoval(['claude-skills']), { acknowledge: true })
      );

      expect({ partial: result.partial, failed: result.failed }).toEqual({
        partial: false,
        failed: [],
      });
      expect(result.removed.map((row) => [row.locationId, row.lastCopy])).toEqual([
        ['claude-skills', true],
      ]);
      expect({ claudeSkill: existsSync(path) }).toEqual({ claudeSkill: false });
      expect(result.backupId).toBeDefined();
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'leaves no staged temp tree beside the destination once it commits',
    async () => {
      const { box } = await openBox();
      seedSkill(box, 'claude-skills', 'one');

      await remove(requestFor(await previewRemoval(['claude-skills']), { acknowledge: true }));

      expect(readdirSync(join(box.home, '.claude', 'skills'))).toEqual([]);
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'restores a removed resource byte-identically through the shared undo route',
    async () => {
      const { box } = await openBox();
      const path = seedSkill(box, 'claude-skills', 'one');
      const before = await hashResourceAt(path, 'directory');

      const result = await remove(
        requestFor(await previewRemoval(['claude-skills']), { acknowledge: true })
      );
      const undone = await undoLibraryPropagation(
        result.backupId ?? '',
        { environmentId: BOX },
        USER.id
      );

      expect(undone.restored.map((row) => row.locationId)).toEqual(['claude-skills']);
      expect(await treeHashes([path])).toEqual([before]);
      expect(readFileSync(join(path, 'reference.md'), 'utf8')).toBe('reference\n');
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'pins the backup set when it holds the last copy of a resource',
    async () => {
      const { box } = await openBox();
      seedSkill(box, 'claude-skills', 'one');

      const result = await remove(
        requestFor(await previewRemoval(['claude-skills']), { acknowledge: true })
      );
      const manifest = await manifestOf(box, result.backupId);

      expect({
        pinned: manifest?.pinned,
        lastCopyResourceKeys: manifest?.lastCopyResourceKeys,
      }).toEqual({ pinned: true, lastCopyResourceKeys: ['skill:gh'] });
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'records the flow that wrote the set, and what the set holds; an ordinary removal is not pinned',
    async () => {
      const { box } = await openBox();
      seedSkill(box, 'claude-skills', 'one');
      seedSkill(box, 'mango-skills', 'one');

      const result = await remove(
        requestFor(await previewRemoval(['claude-skills', 'mango-skills']), {
          keep: (_environmentId, locationId) => locationId === 'mango-skills',
        })
      );
      const manifest = await manifestOf(box, result.backupId);

      expect(result.failed).toEqual([]);
      expect({
        operation: manifest?.operation,
        resourceKeys: manifest?.entries.map((entry) => entry.resourceKey),
        pinned: manifest?.pinned,
      }).toEqual({ operation: 'removal', resourceKeys: ['skill:gh'], pinned: undefined });
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'needs no acknowledgement while a copy survives somewhere',
    async () => {
      const { box } = await openBox();
      for (const id of SKILL_LOCATIONS) seedSkill(box, id, 'one');

      const result = await remove(
        requestFor(await previewRemoval(SKILL_LOCATIONS), {
          keep: (_environmentId, locationId) => locationId === 'cursor-skills',
        })
      );

      expect(result.failed).toEqual([]);
      expect(result.removed).toHaveLength(3);
      expect(present(box, SKILL_LOCATIONS)).toEqual({
        'agents-skills': false,
        'claude-skills': false,
        'cursor-skills': true,
        'mango-skills': false,
      });
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'removes every copy, then restores them all through the shared undo route',
    async () => {
      const { box } = await openBox();
      for (const id of SKILL_LOCATIONS) seedSkill(box, id, 'identical');
      const preview = await previewRemoval(SKILL_LOCATIONS);
      expect(preview.entries[0]?.divergence).toBe('uniform');

      const result = await remove(requestFor(preview, { acknowledge: true }));

      expect({ partial: result.partial, failed: result.failed }).toEqual({
        partial: false,
        failed: [],
      });
      expect(result.removed).toHaveLength(4);
      expect(present(box, SKILL_LOCATIONS)).toEqual(everywhere(false));

      const undone = await undoLibraryPropagation(
        result.backupId ?? '',
        { environmentId: BOX },
        USER.id
      );

      expect(undone.restored).toHaveLength(4);
      expect(present(box, SKILL_LOCATIONS)).toEqual(everywhere(true));
      expect((await previewRemoval(SKILL_LOCATIONS)).entries[0]?.divergence).toBe('uniform');
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'resolves a divergence by removing the copy the user does not want',
    async () => {
      const { box } = await openBox();
      seedSkill(box, 'mango-skills', 'keep this');
      seedSkill(box, 'claude-skills', 'drifted');
      expect((await previewRemoval(['claude-skills'])).entries[0]?.divergence).toBe('divergent');

      const result = await remove(requestFor(await previewRemoval(['claude-skills'])));

      expect(result.failed).toEqual([]);
      expect(result.removed).toHaveLength(1);
      expect((await previewRemoval(['mango-skills'])).entries[0]?.divergence).toBe('single');
    },
    TIMEOUT_MS
  );
});

describe('Rust runtime removal over HTTP', () => {
  it.skipIf(!binary.available)(
    'POST /library/removal/apply removes the last copy once the request acknowledges it',
    async () => {
      const { box } = await openBox();
      const path = seedSkill(box, 'mango-skills', 'only copy');
      const preview = await previewRemoval(['mango-skills']);
      const { app, restore } = createAuthenticatedApiTestApp(
        USER,
        createRemovalRoutes({
          preview: (userId, request) => previewLibraryRemoval(userId, request),
          apply: (userId, request) => applyLibraryRemoval(userId, request),
        })
      );
      restoreAuth = restore;

      const response = await app.handle(
        new Request('http://localhost/library/removal/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestFor(preview, { acknowledge: true })),
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ partial: false });
      expect({ mangoSkill: existsSync(path) }).toEqual({ mangoSkill: false });
    },
    TIMEOUT_MS
  );
});

describe('Rust runtime removal atomicity', () => {
  it.skipIf(!binary.available)(
    'leaves every tree byte-identical when one removal in the middle fails',
    async () => {
      const { fleet: target, box } = await openBox();
      const locations: LibraryLocationId[] = ['agents-skills', 'claude-skills', 'mango-skills'];
      const paths = locations.map((id) => seedSkill(box, id, 'one'));
      const before = await treeHashes(paths);

      const result = await remove(
        requestFor(await previewRemoval(locations), { acknowledge: true }),
        failingAt(target, 2)
      );

      expect({ partial: result.partial, removed: result.removed }).toEqual({
        partial: false,
        removed: [],
      });
      expect(result.failed).toHaveLength(1);
      // The first two trees were staged aside before the third failed; the
      // runtime renamed both back and kept no backup set.
      expect(await treeHashes(paths)).toEqual(before);
      expect(existsSync(box.backupRoot) ? readdirSync(box.backupRoot) : []).toEqual([]);
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'accounts for every reviewed location when the apply stops at a failure',
    async () => {
      const { fleet: target, box } = await openBox();
      for (const id of SKILL_LOCATIONS) seedSkill(box, id, 'one');

      const result = await remove(
        requestFor(await previewRemoval(SKILL_LOCATIONS), { acknowledge: true }),
        failingAt(target, 1)
      );

      expect({ partial: result.partial, removed: result.removed }).toEqual({
        partial: false,
        removed: [],
      });
      expect(result.failed.map((row) => row.locationId)).toEqual(['claude-skills']);
      expect(
        result.kept
          .map((row) => [row.locationId, row.reason])
          .sort((a, b) => ((a[0] ?? '') < (b[0] ?? '') ? -1 : 1))
      ).toEqual([
        ['agents-skills', 'rolled-back'],
        ['cursor-skills', 'not-attempted'],
        ['mango-skills', 'not-attempted'],
      ]);
      expect(present(box, SKILL_LOCATIONS)).toEqual(everywhere(true));
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'refuses to remove a copy whose bytes changed since the preview',
    async () => {
      const { fleet: target, box } = await openBox();
      const path = seedSkill(box, 'claude-skills', 'one');

      const result = await remove(
        requestFor(await previewRemoval(['claude-skills']), { acknowledge: true }),
        failingAt(target, 0)
      );

      expect(result.failed.map((row) => row.reason)).toEqual(['guard-rejected']);
      expect({ claudeSkill: existsSync(path) }).toEqual({ claudeSkill: true });
    },
    TIMEOUT_MS
  );
});

describe('Rust runtime removal across machines', () => {
  it.skipIf(!binary.available)(
    'removes each copy from the machine the preview named',
    async () => {
      const { fleet: target, box } = await openBox();
      const remote = await target.addBox(REMOTE);
      seedSkill(box, 'claude-skills', 'local');
      seedSkill(remote, 'claude-skills', 'remote');

      const result = await remove(
        requestFor(await previewRemoval(['claude-skills'], [BOX, REMOTE]), { acknowledge: true })
      );

      expect(result.failed).toEqual([]);
      expect(result.removed.map((row) => row.environmentId).sort()).toEqual([BOX, REMOTE]);
      expect({
        local: existsSync(skillDir(box, 'claude-skills')),
        remote: existsSync(skillDir(remote, 'claude-skills')),
      }).toEqual({ local: false, remote: false });
      // One irreplaceable set per machine, each on its own disk, and no single
      // handle that would restore half of what was lost.
      expect(result.backups.map((handle) => handle.environmentId).sort()).toEqual([BOX, REMOTE]);
      expect(result.backupId).toBeUndefined();
      expect(readdirSync(remote.backupRoot)).toHaveLength(1);
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'leaves the other machine alone when only one is selected',
    async () => {
      const { fleet: target, box } = await openBox();
      const remote = await target.addBox(REMOTE);
      seedSkill(box, 'claude-skills', 'local');
      seedSkill(remote, 'claude-skills', 'remote');

      const result = await remove(
        requestFor(await previewRemoval(['claude-skills'], [BOX, REMOTE]), {
          keep: (environmentId) => environmentId === REMOTE,
        })
      );

      expect(result.failed).toEqual([]);
      expect({
        local: existsSync(skillDir(box, 'claude-skills')),
        remote: existsSync(skillDir(remote, 'claude-skills')),
      }).toEqual({ local: false, remote: true });
      expect(result.backups.map((handle) => handle.environmentId)).toEqual([BOX]);
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'reports the machine a mid-run failure never reached',
    async () => {
      const { fleet: target, box } = await openBox();
      const remote = await target.addBox(REMOTE);
      const third = await target.addBox(THIRD);
      for (const [machine, body] of [
        [box, 'local'],
        [remote, 'remote'],
        [third, 'third'],
      ] as const) {
        seedSkill(machine, 'claude-skills', body);
      }
      const environmentIds = [BOX, REMOTE, THIRD];

      // The Hub's own preview, with a hash the remote disk no longer holds:
      // that machine's batch fails the runtime guard, and the run stops before
      // reaching the third.
      const staleRemote = async (): Promise<RemovalPreview> => {
        const real = await previewRemoval(['claude-skills'], environmentIds);
        return {
          ...real,
          entries: real.entries.map((entry) => ({
            ...entry,
            locations: entry.locations.map((location) =>
              location.environmentId === REMOTE
                ? { ...location, contentHash: 'stale-hash' }
                : location
            ),
          })),
        };
      };
      const taken = await staleRemote();
      expect(taken.entries[0]?.locations.map((location) => location.environmentId)).toEqual(
        environmentIds
      );

      const result = await remove(requestFor(taken, { acknowledge: true }), {
        preview: () => staleRemote(),
      });

      expect(result.failed.map((row) => row.environmentId)).toEqual([REMOTE]);
      // The first machine committed before the failure; the third was never
      // reached. Neither is something a cross-machine rollback undoes.
      expect({
        local: existsSync(skillDir(box, 'claude-skills')),
        remote: existsSync(skillDir(remote, 'claude-skills')),
        third: existsSync(skillDir(third, 'claude-skills')),
      }).toEqual({ local: false, remote: true, third: true });
      expect(
        result.kept
          .filter((row) => row.environmentId === THIRD)
          .map((row) => [row.locationId, row.reason])
      ).toEqual([['claude-skills', 'not-attempted']]);
    },
    TIMEOUT_MS
  );
});
