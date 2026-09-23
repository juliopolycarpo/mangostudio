/**
 * The Hub's propagation apply and undo, driven through the production
 * protocol path against the compiled Rust runtime.
 *
 * These cases used to run the TypeScript write engine inside the Hub process
 * (`writeEngine: 'in-process'`) against a temp home. Here every write, backup,
 * verification and rollback is done by a real `serve` binary rooted at a
 * scratch home, and every preview is the Hub's production scan of that home.
 * Failure cases use `tamperingApply`: the Hub's own batch goes to the real
 * runtime with one operation's expected hash rewritten, so the runtime writes
 * that destination, fails its verification, and has to put every earlier
 * destination back — the assertions check the disk it left behind.
 *
 * | Former in-process case (`library-propagation-apply.integration.test.ts`) | Replacement here | Fault seam |
 * | --- | --- | --- |
 * | creates, overwrites, and leaves an in-sync destination alone | same name | none |
 * | reports the hash it re-read from disk, not the one it intended to write | same name | none |
 * | backs up the exact bytes it replaced | same name | none |
 * | records the flow that wrote the set, and what each entry holds | same name | none |
 * | reports a pure-overwrite apply as propagation, not as the removal it looks like | same name | none |
 * | writes a propagation_applied row per resource that reached disk | same name | none |
 * | writes no row when every destination is already in sync | same name | none |
 * | restores every destination when a later write fails | restores every destination when a later operation fails | last operation's expected hash tampered |
 * | leaves no partially written skill directory behind | same name | last operation's expected hash tampered |
 * | treats a post-write hash mismatch as a failure and rolls back | same name | sole operation's expected hash tampered |
 * | propagation undo (three cases) | same names | none; the 404 is an unknown set id |
 * | file-backed: instruction, MDC adaptation, subagent TOML, edited bytes | same names | none |
 * | commands: same-format destination stays in sync | same name | none |
 * | honours a skipped destination | same name | none |
 * | takes four diverging locations to uniform | same name | none |
 * | across machines (four cases) | same names | none; two boxes, or two runtime processes on one home |
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  LibraryLocationId,
  PropagationApply,
  PropagationDecision,
  PropagationPreview,
  PropagationPreviewEntry,
  PropagationPreviewRequest,
} from '@mangostudio/shared/library';
import { createBackupStoreDeps, readBackupManifest } from '@mangostudio/shared/library/machine';
import { getDb } from '../../../src/db/database';
import { listDivergenceAcks } from '../../../src/modules/library/application/conflict-resolution';
import {
  applyLibraryPropagation,
  type PropagationApplyDeps,
  undoLibraryPropagation,
} from '../../../src/modules/library/application/propagation-apply';
import { previewLibraryPropagation } from '../../../src/modules/library/application/propagation-preview';
import {
  type LibraryBox,
  type LibraryFleet,
  openLibraryFleet,
  tamperingApply,
} from '../../support/rust-library-boxes';
import { resolveRustRuntimeBinary } from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();
const TIMEOUT_MS = 60_000;
const USER = {
  id: 'rust-library-propagation-user',
  name: 'Rust Library Propagation User',
  email: 'rust-library-propagation@mangostudio.test',
};
const BOX = 'rust-propagation-box';

const SKILL_LOCATIONS: readonly LibraryLocationId[] = [
  'mango-skills',
  'agents-skills',
  'claude-skills',
  'cursor-skills',
];
const INSTRUCTION_LOCATIONS: readonly LibraryLocationId[] = [
  'mango-instructions',
  'claude-instructions',
  'codex-instructions',
];
const ALL_LOCATIONS: readonly LibraryLocationId[] = [
  ...SKILL_LOCATIONS,
  ...INSTRUCTION_LOCATIONS,
  'claude-agents',
  'codex-agents',
  'claude-commands',
  'codex-prompts',
  'cursor-rules',
];
const SKILL_DIRECTORIES: Record<string, readonly string[]> = {
  'mango-skills': ['.mango', 'skills'],
  'agents-skills': ['.agents', 'skills'],
  'claude-skills': ['.claude', 'skills'],
  'cursor-skills': ['.cursor', 'skills'],
};
const FILES: Record<string, readonly string[]> = {
  'mango-instructions': ['.mango', 'AGENTS.md'],
  'claude-instructions': ['.claude', 'CLAUDE.md'],
  'codex-instructions': ['.codex', 'AGENTS.md'],
  'cursor-rules': ['.cursor', 'rules', 'global.mdc'],
  'claude-agents': ['.claude', 'agents', 'reviewer.md'],
  'codex-agents': ['.codex', 'agents', 'reviewer.toml'],
  'claude-commands': ['.claude', 'commands', 'deploy.md'],
  'codex-prompts': ['.codex', 'prompts', 'deploy.md'],
};

let fleet: LibraryFleet | undefined;

afterEach(async () => {
  await fleet?.dispose();
  fleet = undefined;
});

/** One box registered as `BOX`, every library location enabled. */
async function openBox(): Promise<{ fleet: LibraryFleet; box: LibraryBox }> {
  fleet = await openLibraryFleet(binary, USER);
  const box = await fleet.addBox(BOX);
  fleet.enableHomeLocations(ALL_LOCATIONS);
  return { fleet, box };
}

function skillDir(box: LibraryBox, locationId: LibraryLocationId): string {
  return join(box.home, ...(SKILL_DIRECTORIES[locationId] ?? []), 'gh');
}

function writeSkill(box: LibraryBox, locationId: LibraryLocationId, body: string): void {
  mkdirSync(skillDir(box, locationId), { recursive: true });
  writeFileSync(
    join(skillDir(box, locationId), 'SKILL.md'),
    `---\nname: gh\ndescription: GitHub\n---\n${body}`
  );
}

/** The skill body, or `<absent>` so a missing copy reads as a value, not a throw. */
function skillBody(box: LibraryBox, locationId: LibraryLocationId): string {
  const path = join(skillDir(box, locationId), 'SKILL.md');
  return existsSync(path) ? (readFileSync(path, 'utf8').split('---\n')[2] ?? '') : '<absent>';
}

function makeDirectories(box: LibraryBox, ...locationIds: LibraryLocationId[]): void {
  for (const id of locationIds) {
    mkdirSync(join(box.home, ...(SKILL_DIRECTORIES[id] ?? [])), { recursive: true });
  }
}

function filePath(box: LibraryBox, locationId: LibraryLocationId): string {
  return join(box.home, ...(FILES[locationId] ?? []));
}

function writeAt(box: LibraryBox, locationId: LibraryLocationId, body: string): void {
  mkdirSync(dirname(filePath(box, locationId)), { recursive: true });
  writeFileSync(filePath(box, locationId), body);
}

/** Backup sets left in a box's store (a rolled-back apply must leave none). */
function storedSets(box: LibraryBox): string[] {
  return existsSync(box.backupRoot) ? readdirSync(box.backupRoot) : [];
}

function onlyEntry(taken: PropagationPreview): PropagationPreviewEntry {
  const entry = taken.entries[0];
  if (!entry) throw new Error('expected one preview entry | received none');
  return entry;
}

function winnerFrom(entry: PropagationPreviewEntry, locationId: LibraryLocationId): string {
  const group = entry.sourceGroups.find((candidate) => candidate.locationIds.includes(locationId));
  if (!group) throw new Error(`expected a source group holding ${locationId} | received none`);
  return group.contentHash;
}

function adoptAll(
  entry: PropagationPreviewEntry,
  winnerContentHash: string,
  options: {
    readonly skip?: readonly LibraryLocationId[];
    readonly only?: (environmentId: string, locationId: string) => boolean;
    readonly strategy?: 'mechanical';
  } = {}
): PropagationDecision {
  return {
    resourceKey: entry.resourceKey,
    resolution: 'adopt-group',
    winnerContentHash,
    destinations: entry.destinations.map((destination) => {
      const skipped =
        options.skip?.includes(destination.locationId) ||
        (options.only && !options.only(destination.environmentId, destination.locationId));
      return {
        environmentId: destination.environmentId,
        locationId: destination.locationId,
        action: skipped ? ('skip' as const) : ('apply' as const),
        ...(options.strategy && { strategy: options.strategy }),
      };
    }),
  };
}

interface Taken {
  readonly taken: PropagationPreview;
  readonly request: PropagationPreviewRequest;
  readonly entry: PropagationPreviewEntry;
}

async function previewOf(
  resourceKey: string,
  targetLocationIds: readonly LibraryLocationId[],
  environmentIds: readonly string[] = [BOX]
): Promise<Taken> {
  const request: PropagationPreviewRequest = {
    resourceKeys: [resourceKey],
    targetLocationIds: [...targetLocationIds],
    environmentIds: [...environmentIds],
  };
  const taken = await previewLibraryPropagation(USER.id, request);
  return { taken, request, entry: onlyEntry(taken) };
}

function previewSkill(environmentIds?: readonly string[]): Promise<Taken> {
  return previewOf('skill:gh', SKILL_LOCATIONS, environmentIds);
}

function apply(
  { taken, request }: Taken,
  decisions: PropagationDecision[],
  deps: Partial<PropagationApplyDeps> = {}
): Promise<PropagationApply> {
  return applyLibraryPropagation(
    USER.id,
    { previewToken: taken.previewToken, stateHash: taken.stateHash, request, decisions },
    deps
  );
}

function undo(backupId: string | undefined, environmentId = BOX) {
  return undoLibraryPropagation(backupId ?? '', { environmentId }, USER.id);
}

/** Fails verification of the last operation the runtime is sent. */
function failingLast(target: LibraryFleet): Partial<PropagationApplyDeps> {
  return {
    runtimeApply: tamperingApply(target, (operation, index, all) =>
      index === all.length - 1 ? { ...operation, expectedContentHash: 'tampered' } : operation
    ),
  };
}

describe('Rust runtime propagation — writing and verifying', () => {
  it.skipIf(!binary.available)(
    'creates, overwrites, and leaves an in-sync destination alone',
    async () => {
      const { box } = await openBox();
      writeSkill(box, 'mango-skills', 'winner\n');
      writeSkill(box, 'agents-skills', 'winner\n');
      writeSkill(box, 'claude-skills', 'stale\n');
      makeDirectories(box, 'cursor-skills');

      const taken = await previewSkill();
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills')),
      ]);

      expect({ partial: result.partial, failed: result.failed }).toEqual({
        partial: false,
        failed: [],
      });
      expect(result.applied.map((item) => `${item.locationId}:${item.operation}`).sort()).toEqual([
        'claude-skills:overwrite',
        'cursor-skills:create',
      ]);
      expect(result.skipped.map((item) => item.reason).sort()).toEqual([
        'already-in-sync',
        'already-in-sync',
      ]);
      expect(SKILL_LOCATIONS.map((id) => [id, skillBody(box, id)])).toEqual(
        SKILL_LOCATIONS.map((id) => [id, 'winner\n'])
      );
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'reports the hash it re-read from disk, not the one it intended to write',
    async () => {
      const { box } = await openBox();
      writeSkill(box, 'mango-skills', 'source\n');
      makeDirectories(box, 'claude-skills');

      const taken = await previewSkill();
      const winner = winnerFrom(taken.entry, 'mango-skills');
      const result = await apply(taken, [adoptAll(taken.entry, winner)]);

      expect(result.applied.length).toBeGreaterThan(0);
      expect(result.applied.map((item) => item.contentHash)).toEqual(
        result.applied.map(() => winner)
      );
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'backs up the exact bytes it replaced',
    async () => {
      const { box } = await openBox();
      writeSkill(box, 'mango-skills', 'new\n');
      writeSkill(box, 'claude-skills', 'original\n');

      const taken = await previewSkill();
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills')),
      ]);

      const backupPath = join(
        box.backupRoot,
        result.backupId ?? '<no backup id>',
        'claude-skills',
        'gh',
        'SKILL.md'
      );
      expect(readFileSync(backupPath, 'utf8')).toContain('original\n');
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'records the flow that wrote the set, and what each entry holds',
    async () => {
      const { box } = await openBox();
      writeSkill(box, 'mango-skills', 'winner\n');
      makeDirectories(box, 'claude-skills');

      const taken = await previewSkill();
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills')),
      ]);

      const manifest = await readBackupManifest(
        result.backupId ?? '',
        createBackupStoreDeps({ backupRoot: box.backupRoot })
      );
      expect(manifest?.operation).toBe('propagation');
      expect(manifest?.entries.length).toBeGreaterThan(0);
      expect(manifest?.entries.map((backed) => backed.resourceKey)).toEqual(
        manifest?.entries.map(() => 'skill:gh')
      );
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'reports a pure-overwrite apply as propagation, not as the removal it looks like',
    async () => {
      const { box } = await openBox();
      writeSkill(box, 'mango-skills', 'winner\n');
      writeSkill(box, 'agents-skills', 'stale-a\n');
      writeSkill(box, 'claude-skills', 'stale-b\n');
      writeSkill(box, 'cursor-skills', 'stale-c\n');

      const taken = await previewSkill();
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills')),
      ]);

      const manifest = await readBackupManifest(
        result.backupId ?? '',
        createBackupStoreDeps({ backupRoot: box.backupRoot })
      );
      expect(result.applied.map((item) => item.operation)).toEqual([
        'overwrite',
        'overwrite',
        'overwrite',
      ]);
      expect(manifest?.entries.length).toBeGreaterThan(0);
      expect(manifest?.entries.filter((backed) => backed.backupPath === undefined)).toEqual([]);
      expect(manifest?.operation).toBe('propagation');
    },
    TIMEOUT_MS
  );
});

describe('Rust runtime propagation — activity emission', () => {
  /** Fire-and-forget from `runApply`; one macrotask turn settles bun:sqlite. */
  const flushActivity = () => new Promise((resolve) => setTimeout(resolve, 0));

  const appliedRows = () =>
    getDb()
      .selectFrom('activity_events')
      .selectAll()
      .where('userId', '=', USER.id)
      .where('kind', '=', 'propagation_applied')
      .execute();

  it.skipIf(!binary.available)(
    'writes a propagation_applied row per resource that reached disk',
    async () => {
      const { box } = await openBox();
      writeSkill(box, 'mango-skills', 'winner\n');
      makeDirectories(box, 'claude-skills');

      const taken = await previewSkill();
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills')),
      ]);
      expect(result.applied.length).toBeGreaterThan(0);
      await flushActivity();

      const rows = await appliedRows();
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0]?.payloadJson ?? '{}');
      expect(payload).toMatchObject({ resourceKind: 'skill', resourceName: 'gh' });
      expect(payload.targets.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'writes no row when every destination is already in sync',
    async () => {
      const { box } = await openBox();
      for (const locationId of SKILL_LOCATIONS) writeSkill(box, locationId, 'winner\n');

      const taken = await previewSkill();
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills')),
      ]);
      expect(result.applied).toEqual([]);
      await flushActivity();

      expect(await appliedRows()).toEqual([]);
    },
    TIMEOUT_MS
  );
});

describe('Rust runtime propagation — all-or-nothing', () => {
  it.skipIf(!binary.available)(
    'restores every destination when a later operation fails',
    async () => {
      const { fleet: target, box } = await openBox();
      writeSkill(box, 'mango-skills', 'winner\n');
      writeSkill(box, 'agents-skills', 'first-original\n');
      writeSkill(box, 'claude-skills', 'second-original\n');
      makeDirectories(box, 'cursor-skills');

      const taken = await previewSkill();
      const result = await apply(
        taken,
        [adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills'))],
        failingLast(target)
      );

      expect({ partial: result.partial, applied: result.applied }).toEqual({
        partial: false,
        applied: [],
      });
      expect(result.failed).toMatchObject([
        { locationId: 'cursor-skills', reason: 'verification-failed' },
      ]);
      // Both overwrites landed before the failing operation; the runtime put
      // them back, removed its own create, and kept no backup set.
      expect(SKILL_LOCATIONS.map((id) => [id, skillBody(box, id)])).toEqual([
        ['mango-skills', 'winner\n'],
        ['agents-skills', 'first-original\n'],
        ['claude-skills', 'second-original\n'],
        ['cursor-skills', '<absent>'],
      ]);
      expect({ backups: result.backups, storedSets: storedSets(box) }).toEqual({
        backups: [],
        storedSets: [],
      });
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'leaves no partially written skill directory behind',
    async () => {
      const { fleet: target, box } = await openBox();
      writeSkill(box, 'mango-skills', 'winner\n');
      makeDirectories(box, 'claude-skills', 'cursor-skills');

      const taken = await previewSkill();
      const result = await apply(
        taken,
        [adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills'))],
        failingLast(target)
      );

      expect(result.partial).toBe(false);
      // The claude create succeeded and was compensated by removal.
      expect({
        claudeSkill: existsSync(skillDir(box, 'claude-skills')),
        cursorSkill: existsSync(skillDir(box, 'cursor-skills')),
        claudeRootEntries: readdirSync(join(box.home, '.claude', 'skills')),
      }).toEqual({ claudeSkill: false, cursorSkill: false, claudeRootEntries: [] });
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'treats a post-write hash mismatch as a failure and rolls back',
    async () => {
      const { fleet: target, box } = await openBox();
      writeSkill(box, 'mango-skills', 'winner\n');
      writeSkill(box, 'claude-skills', 'original\n');
      writeSkill(box, 'agents-skills', 'winner\n');
      writeSkill(box, 'cursor-skills', 'winner\n');

      const taken = await previewSkill();
      const result = await apply(
        taken,
        [adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills'))],
        failingLast(target)
      );

      expect(result.applied).toEqual([]);
      expect(result.failed).toMatchObject([
        { locationId: 'claude-skills', reason: 'verification-failed' },
      ]);
      expect(result.partial).toBe(false);
      expect(skillBody(box, 'claude-skills')).toBe('original\n');
    },
    TIMEOUT_MS
  );
});

describe('Rust runtime propagation — undo', () => {
  it.skipIf(!binary.available)(
    'restores overwritten content and removes what the apply created',
    async () => {
      const { box } = await openBox();
      writeSkill(box, 'mango-skills', 'winner\n');
      writeSkill(box, 'claude-skills', 'original\n');
      makeDirectories(box, 'cursor-skills');

      const taken = await previewSkill();
      const applied = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills')),
      ]);
      expect(applied.backupId).toBeDefined();

      const undone = await undo(applied.backupId);

      expect(undone.restored.map((item) => item.locationId)).toEqual(['claude-skills']);
      expect(undone.removed.map((item) => item.locationId).sort()).toEqual([
        'agents-skills',
        'cursor-skills',
      ]);
      expect([skillBody(box, 'claude-skills'), skillBody(box, 'cursor-skills')]).toEqual([
        'original\n',
        '<absent>',
      ]);
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'leaves a destination alone when it changed after the apply',
    async () => {
      const { box } = await openBox();
      writeSkill(box, 'mango-skills', 'winner\n');
      writeSkill(box, 'claude-skills', 'original\n');

      const taken = await previewSkill();
      const applied = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills'), {
          skip: ['agents-skills', 'cursor-skills'],
        }),
      ]);

      writeSkill(box, 'claude-skills', 'edited after the apply\n');
      const undone = await undo(applied.backupId);

      expect(undone.restored).toEqual([]);
      expect(undone.skipped).toMatchObject([{ reason: 'changed-since-apply' }]);
      expect(skillBody(box, 'claude-skills')).toBe('edited after the apply\n');
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'reports a backup that retention has already discarded',
    async () => {
      await openBox();
      await expect(undo('2020-01-01T00-00-00.000Z-deadbeef')).rejects.toMatchObject({
        status: 404,
      });
    },
    TIMEOUT_MS
  );
});

describe('Rust runtime propagation — file-backed resources', () => {
  it.skipIf(!binary.available)(
    'propagates a single-file instruction to its peers',
    async () => {
      const { box } = await openBox();
      writeAt(box, 'claude-instructions', '# House rules\n');
      mkdirSync(join(box.home, '.mango'), { recursive: true });
      mkdirSync(join(box.home, '.codex'), { recursive: true });

      const taken = await previewOf('instruction:global', INSTRUCTION_LOCATIONS);
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'claude-instructions')),
      ]);

      expect(result.failed).toEqual([]);
      expect([
        readFileSync(filePath(box, 'mango-instructions'), 'utf8'),
        readFileSync(filePath(box, 'codex-instructions'), 'utf8'),
      ]).toEqual(['# House rules\n', '# House rules\n']);
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'mechanically adapts plain instructions to MDC before the atomic write',
    async () => {
      const { box } = await openBox();
      writeAt(box, 'claude-instructions', '﻿# House rules\r\n\r\nKeep changes focused.\r\n');
      mkdirSync(join(box.home, '.cursor', 'rules'), { recursive: true });

      const taken = await previewOf('instruction:global', ['cursor-rules']);
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'claude-instructions'), {
          strategy: 'mechanical',
        }),
      ]);

      expect(result.failed).toEqual([]);
      expect(readFileSync(filePath(box, 'cursor-rules'), 'utf8')).toBe(
        '---\ndescription: "House rules"\nalwaysApply: true\n---\n\n﻿# House rules\r\n\r\nKeep changes focused.\r\n'
      );
      expect(result.applied[0]?.adaptation).toMatchObject({
        strategy: 'mechanical',
        lossy: false,
        requiresReview: false,
        notes: [
          { code: 'metadata-added', field: 'description' },
          { code: 'metadata-added', field: 'alwaysApply' },
        ],
      });
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'normalizes a Claude subagent into Codex TOML through propagation',
    async () => {
      const { box } = await openBox();
      writeAt(
        box,
        'claude-agents',
        '---\nname: "reviewer"\ndescription: "Reviews changes"\ntools:\n  - "Read"\n---\n\nReview carefully.\n'
      );
      mkdirSync(join(box.home, '.codex', 'agents'), { recursive: true });

      const taken = await previewOf('subagent:reviewer', ['codex-agents']);
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'claude-agents'), {
          strategy: 'mechanical',
        }),
      ]);

      expect(result.failed).toEqual([]);
      expect(readFileSync(filePath(box, 'codex-agents'), 'utf8')).toBe(
        'name = "reviewer"\ndescription = "Reviews changes"\ndeveloper_instructions = "Review carefully.\\n"\n'
      );
      expect(result.applied[0]?.adaptation).toMatchObject({
        strategy: 'mechanical',
        lossy: true,
        notes: [{ code: 'field-dropped', field: 'tools' }],
      });
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'adopts edited bytes that exist in no location yet',
    async () => {
      const { box } = await openBox();
      writeAt(box, 'claude-instructions', '# Original\n');
      writeAt(box, 'codex-instructions', '# Different\n');
      mkdirSync(join(box.home, '.mango'), { recursive: true });

      const taken = await previewOf('instruction:global', INSTRUCTION_LOCATIONS);
      const result = await apply(taken, [
        {
          resourceKey: taken.entry.resourceKey,
          resolution: 'edit-then-adopt',
          editedContent: '# Merged by hand\n',
          destinations: taken.entry.destinations.map((destination) => ({
            environmentId: destination.environmentId,
            locationId: destination.locationId,
            action: 'apply' as const,
          })),
        },
      ]);

      expect(result.failed).toEqual([]);
      expect(
        INSTRUCTION_LOCATIONS.map((id) => [id, readFileSync(filePath(box, id), 'utf8')])
      ).toEqual(INSTRUCTION_LOCATIONS.map((id) => [id, '# Merged by hand\n']));
      expect(new Set(result.applied.map((item) => item.contentHash)).size).toBe(1);
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'offers a same-format command destination with no adapter conversion, then stays in sync after apply',
    async () => {
      const { box } = await openBox();
      writeAt(box, 'claude-commands', '---\ndescription: Deploy the app\n---\nDeploy steps.\n');
      mkdirSync(join(box.home, '.codex', 'prompts'), { recursive: true });

      const taken = await previewOf('command:deploy', ['codex-prompts']);
      const winner = winnerFrom(taken.entry, 'claude-commands');
      const destination = taken.entry.destinations.find((d) => d.locationId === 'codex-prompts');
      const outcome = destination?.outcomes.find(
        (candidate) => candidate.winnerContentHash === winner
      );
      expect({
        blockedReason: destination?.blockedReason,
        toFormat: destination?.toFormat,
        operation: outcome?.operation,
        adaptation: outcome?.adaptation,
      }).toEqual({
        blockedReason: undefined,
        toFormat: 'markdown-frontmatter',
        operation: 'create',
        adaptation: undefined,
      });

      const result = await apply(taken, [adoptAll(taken.entry, winner)]);

      expect(result.failed).toEqual([]);
      expect(readFileSync(filePath(box, 'codex-prompts'), 'utf8')).toBe(
        readFileSync(filePath(box, 'claude-commands'), 'utf8')
      );
      expect(result.applied[0]).toMatchObject({
        locationId: 'codex-prompts',
        operation: 'create',
        contentHash: winner,
      });
      const rescan = await previewOf('command:deploy', ['codex-prompts']);
      expect(rescan.entry.divergence).toBe('uniform');
    },
    TIMEOUT_MS
  );
});

describe('Rust runtime propagation — decisions and end to end', () => {
  it.skipIf(!binary.available)(
    'honours a skipped destination',
    async () => {
      const { box } = await openBox();
      writeSkill(box, 'mango-skills', 'winner\n');
      makeDirectories(box, 'claude-skills', 'cursor-skills');

      const taken = await previewSkill();
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills'), {
          skip: ['cursor-skills'],
        }),
      ]);

      expect(result.skipped).toContainEqual({
        resourceKey: 'skill:gh',
        environmentId: BOX,
        locationId: 'cursor-skills',
        reason: 'user-skipped',
      });
      expect([skillBody(box, 'cursor-skills'), skillBody(box, 'claude-skills')]).toEqual([
        '<absent>',
        'winner\n',
      ]);
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'takes four diverging locations to uniform through preview, decide, apply',
    async () => {
      const { box } = await openBox();
      writeSkill(box, 'mango-skills', 'a\n');
      writeSkill(box, 'agents-skills', 'b\n');
      writeSkill(box, 'claude-skills', 'c\n');
      makeDirectories(box, 'cursor-skills');

      const before = await previewSkill();
      expect(before.entry.divergence).toBe('divergent');
      const applied = await apply(before, [
        adoptAll(before.entry, winnerFrom(before.entry, 'agents-skills')),
      ]);
      expect(applied.failed).toEqual([]);

      const after = await previewSkill();
      expect({
        divergence: after.entry.divergence,
        groups: after.entry.sourceGroups.map((group) => group.instanceCount),
      }).toEqual({ divergence: 'uniform', groups: [4] });
      expect(await listDivergenceAcks(USER.id)).toEqual([]);
    },
    TIMEOUT_MS
  );
});

/*
  Two machines, two homes, one Hub — each a real `serve` binary. A write
  landing in the wrong home, a backup on the wrong disk, or a second write to
  the same physical home clobbering the first is only visible through the
  Hub's per-machine dispatch, which is what runs here.
*/
describe('Rust runtime propagation — across machines', () => {
  const REMOTE = 'rust-propagation-remote';
  const TWIN = 'rust-propagation-twin';

  it.skipIf(!binary.available)(
    'copies a skill from one machine into another, leaving the source untouched',
    async () => {
      const { fleet: target, box } = await openBox();
      const remote = await target.addBox(REMOTE);
      writeSkill(box, 'mango-skills', 'winner\n');
      makeDirectories(remote, 'claude-skills');

      const taken = await previewSkill([BOX, REMOTE]);
      const destination = taken.entry.destinations.find(
        (d) => d.environmentId === REMOTE && d.locationId === 'claude-skills'
      );
      expect(destination?.blockedReason).toBeUndefined();
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills'), {
          only: (environmentId, locationId) =>
            environmentId === REMOTE && locationId === 'claude-skills',
        }),
      ]);

      expect(result.failed).toEqual([]);
      expect(result.applied.map((row) => `${row.environmentId}:${row.locationId}`)).toEqual([
        `${REMOTE}:claude-skills`,
      ]);
      expect(skillBody(remote, 'claude-skills')).toBe('winner\n');
      expect({ sourceMachineClaude: existsSync(skillDir(box, 'claude-skills')) }).toEqual({
        sourceMachineClaude: false,
      });
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'backs up on the machine it wrote to, not on the hub',
    async () => {
      const { fleet: target, box } = await openBox();
      const remote = await target.addBox(REMOTE);
      writeSkill(box, 'mango-skills', 'winner\n');
      writeSkill(remote, 'claude-skills', 'stale\n');

      const taken = await previewSkill([BOX, REMOTE]);
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills'), {
          only: (environmentId, locationId) =>
            environmentId === REMOTE && locationId === 'claude-skills',
        }),
      ]);

      expect(result.backups).toEqual([{ environmentId: REMOTE, backupId: expect.any(String) }]);
      expect({ remoteSets: storedSets(remote).length, sourceSets: storedSets(box) }).toEqual({
        remoteSets: 1,
        sourceSets: [],
      });
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'converges when two environments turn out to be the same machine',
    async () => {
      const { fleet: target, box } = await openBox();
      await target.addBox(TWIN, { sameHomeAs: box });
      writeSkill(box, 'mango-skills', 'winner\n');
      writeSkill(box, 'claude-skills', 'stale\n');

      const taken = await previewSkill([BOX, TWIN]);
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills'), {
          only: (_environmentId, locationId) => locationId === 'claude-skills',
        }),
      ]);

      // The second batch finds the first one's content, hash-verifies, and
      // succeeds rather than failing verification or corrupting the file.
      expect(result.failed).toEqual([]);
      expect(result.applied).toHaveLength(2);
      expect(skillBody(box, 'claude-skills')).toBe('winner\n');
      expect(result.backups).toHaveLength(2);
    },
    TIMEOUT_MS
  );

  it.skipIf(!binary.available)(
    'produces one backup set per machine when a write spans both',
    async () => {
      const { fleet: target, box } = await openBox();
      const remote = await target.addBox(REMOTE);
      writeSkill(box, 'mango-skills', 'winner\n');
      writeSkill(box, 'claude-skills', 'stale-local\n');
      writeSkill(remote, 'claude-skills', 'stale-remote\n');

      const taken = await previewSkill([BOX, REMOTE]);
      const result = await apply(taken, [
        adoptAll(taken.entry, winnerFrom(taken.entry, 'mango-skills'), {
          only: (_environmentId, locationId) => locationId === 'claude-skills',
        }),
      ]);

      expect(result.failed).toEqual([]);
      expect(result.backups.map((handle) => handle.environmentId).sort()).toEqual([BOX, REMOTE]);
      expect(result.backupId).toBeUndefined();
    },
    TIMEOUT_MS
  );
});
