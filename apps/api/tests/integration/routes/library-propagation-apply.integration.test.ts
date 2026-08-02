import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeLibraryApplyParams } from '@mangostudio/runtime';
import {
  DEFAULT_APP_SETTINGS,
  libraryLocationsFor,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import type {
  LibraryLocationId,
  PropagationApply,
  PropagationApplyRequest,
  PropagationDecision,
  PropagationPreview,
  PropagationPreviewEntry,
  PropagationPreviewRequest,
} from '@mangostudio/shared/library';
import { enabledLibraryLocations } from '@mangostudio/shared/library';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { getDb } from '../../../src/db/database';
import { listDivergenceAcks } from '../../../src/modules/library/application/conflict-resolution';
import { discoverLibraryResources } from '../../../src/modules/library/application/library-discovery';
import {
  applyLibraryPropagation,
  type PropagationApplyDeps,
  undoLibraryPropagation,
} from '../../../src/modules/library/application/propagation-apply';
import { previewLibraryPropagation } from '../../../src/modules/library/application/propagation-preview';
import {
  type BackupStoreDeps,
  defaultBackupStoreDeps,
  readBackupManifest,
} from '../../../src/modules/library/infrastructure/backup-store';
import { LibraryCache } from '../../../src/modules/library/infrastructure/library-cache';
import {
  createLibraryPathEnv,
  describeLocation,
} from '../../../src/modules/library/infrastructure/location-probe';
import {
  type ResourceWriterDeps,
  writeDirectoryResource,
  writeFileResource,
} from '../../../src/modules/library/infrastructure/resource-writer';

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
const SUBAGENT_LOCATIONS: readonly LibraryLocationId[] = ['claude-agents', 'codex-agents'];

const LOCATION_DIRECTORIES: Record<string, readonly string[]> = {
  'mango-skills': ['.mango', 'skills'],
  'agents-skills': ['.agents', 'skills'],
  'claude-skills': ['.claude', 'skills'],
  'cursor-skills': ['.cursor', 'skills'],
};
const INSTRUCTION_FILES: Record<string, readonly string[]> = {
  'mango-instructions': ['.mango', 'AGENTS.md'],
  'claude-instructions': ['.claude', 'CLAUDE.md'],
  'codex-instructions': ['.codex', 'AGENTS.md'],
  'cursor-rules': ['.cursor', 'rules', 'global.mdc'],
};
const SUBAGENT_FILES: Record<string, readonly string[]> = {
  'claude-agents': ['.claude', 'agents', 'reviewer.md'],
  'codex-agents': ['.codex', 'agents', 'reviewer.toml'],
};

let home: string;
let backupRoot: string;
let userSeq = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mango-apply-'));
  backupRoot = join(home, 'backups');
  userSeq += 1;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const userId = () => `library-apply-user-${userSeq}`;

function skillPath(locationId: LibraryLocationId): string {
  return join(home, ...(LOCATION_DIRECTORIES[locationId] ?? []), 'gh');
}

function writeSkill(locationId: LibraryLocationId, body: string): void {
  const dir = skillPath(locationId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: gh\ndescription: GitHub\n---\n${body}`);
}

function readSkill(locationId: LibraryLocationId): string {
  return readFileSync(join(skillPath(locationId), 'SKILL.md'), 'utf8');
}

function instructionPath(locationId: LibraryLocationId): string {
  return join(home, ...(INSTRUCTION_FILES[locationId] ?? []));
}

function writeInstruction(locationId: LibraryLocationId, body: string): void {
  const path = instructionPath(locationId);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

function subagentPath(locationId: LibraryLocationId): string {
  return join(home, ...(SUBAGENT_FILES[locationId] ?? []));
}

function writeSubagent(locationId: LibraryLocationId, body: string): void {
  const path = subagentPath(locationId);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

function makeDirectories(...locationIds: LibraryLocationId[]): void {
  for (const locationId of locationIds) {
    mkdirSync(join(home, ...(LOCATION_DIRECTORIES[locationId] ?? [])), { recursive: true });
  }
}

function pathEnv() {
  return createLibraryPathEnv({
    homeDir: home,
    env: { SKILLS_DIR: join(home, '.mango', 'skills') },
  });
}

function settings(locationIds: readonly LibraryLocationId[]): typeof DEFAULT_APP_SETTINGS {
  return withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
    home: Object.fromEntries(locationIds.map((id) => [id, true])),
    workspace: {},
  });
}

function preview(request: PropagationPreviewRequest): Promise<PropagationPreview> {
  const env = pathEnv();
  const cache = new LibraryCache();
  const enabled = settings([
    ...SKILL_LOCATIONS,
    ...INSTRUCTION_LOCATIONS,
    ...SUBAGENT_LOCATIONS,
    'cursor-rules',
  ]);
  return previewLibraryPropagation(userId(), request, {
    discover: (scanUserId, kinds) =>
      discoverLibraryResources(getDb(), scanUserId, {
        force: true,
        kinds,
        cache,
        pathEnv: env,
        settings: enabled,
      }),
    describeLocation: (id) => describeLocation(id, env),
    enabledLocationIds: async () => enabledLibraryLocations(libraryLocationsFor(enabled), 'home'),
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

function writerOverrides(): Partial<ResourceWriterDeps> {
  return {
    backupDir: () => backupRoot,
    backupRetentionCount: () => 10,
    backupRetentionBytes: () => 1024 ** 3,
  };
}

function applyDeps(overrides: Partial<PropagationApplyDeps> = {}): Partial<PropagationApplyDeps> {
  return {
    preview: (_userId, request) => preview(request),
    pathEnv,
    // The parity bar: these suites drive the write engine directly against a
    // temp home. Tests that mean to exercise the protocol say so by passing
    // `writeEngine: 'runtime'` with a `runtimeApply` stub.
    writeEngine: 'in-process',
    backup: backupDeps(),
    writeDirectory: (input) => writeDirectoryResource(input, writerOverrides()),
    writeFile: (input) => writeFileResource(input, writerOverrides()),
    ...overrides,
  };
}

function toRequest(
  taken: PropagationPreview,
  request: PropagationPreviewRequest,
  decisions: PropagationDecision[]
): PropagationApplyRequest {
  return {
    previewToken: taken.previewToken,
    stateHash: taken.stateHash,
    request,
    decisions,
  };
}

function adoptAll(
  entry: PropagationPreviewEntry,
  winnerContentHash: string,
  skip: readonly LibraryLocationId[] = [],
  strategy?: 'mechanical' | 'verbatim' | 'agent'
): PropagationDecision {
  return {
    resourceKey: entry.resourceKey,
    resolution: 'adopt-group',
    winnerContentHash,
    destinations: entry.destinations.map((destination) => ({
      locationId: destination.locationId,
      action: skip.includes(destination.locationId) ? ('skip' as const) : ('apply' as const),
      ...(strategy && { strategy }),
    })),
  };
}

function onlyEntry(taken: PropagationPreview): PropagationPreviewEntry {
  const entry = taken.entries[0];
  if (!entry) throw new Error('Preview returned no entries.');
  return entry;
}

function winnerFrom(entry: PropagationPreviewEntry, locationId: LibraryLocationId): string {
  const group = entry.sourceGroups.find((candidate) => candidate.locationIds.includes(locationId));
  if (!group) throw new Error(`No source group holds ${locationId}`);
  return group.contentHash;
}

async function previewSkill(): Promise<{
  taken: PropagationPreview;
  request: PropagationPreviewRequest;
  entry: PropagationPreviewEntry;
}> {
  const request: PropagationPreviewRequest = {
    resourceKeys: ['skill:gh'],
    targetLocationIds: [...SKILL_LOCATIONS],
  };
  const taken = await preview(request);
  return { taken, request, entry: onlyEntry(taken) };
}

describe('propagation apply — writing and verifying', () => {
  it('creates, overwrites, and leaves an in-sync destination alone', async () => {
    writeSkill('mango-skills', 'winner\n');
    writeSkill('agents-skills', 'winner\n');
    writeSkill('claude-skills', 'stale\n');
    makeDirectories('cursor-skills');

    const { taken, request, entry } = await previewSkill();
    const winner = winnerFrom(entry, 'mango-skills');
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winner)]),
      applyDeps()
    );

    expect(result.partial).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.applied.map((item) => `${item.locationId}:${item.operation}`).sort()).toEqual([
      'claude-skills:overwrite',
      'cursor-skills:create',
    ]);
    expect(result.skipped.map((item) => item.reason).sort()).toEqual([
      'already-in-sync',
      'already-in-sync',
    ]);
    for (const locationId of SKILL_LOCATIONS) {
      expect(readSkill(locationId)).toContain('winner\n');
    }
  });

  it('reports the hash it re-read from disk, not the one it intended to write', async () => {
    writeSkill('mango-skills', 'source\n');
    makeDirectories('claude-skills');

    const { taken, request, entry } = await previewSkill();
    const winner = winnerFrom(entry, 'mango-skills');
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winner)]),
      applyDeps()
    );

    expect(result.applied.every((item) => item.contentHash === winner)).toBe(true);
  });

  it('backs up the exact bytes it replaced', async () => {
    writeSkill('mango-skills', 'new\n');
    writeSkill('claude-skills', 'original\n');

    const { taken, request, entry } = await previewSkill();
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'mango-skills'))]),
      applyDeps()
    );

    const backupPath = join(backupRoot, result.backupId ?? '', 'claude-skills', 'gh', 'SKILL.md');
    expect(readFileSync(backupPath, 'utf8')).toContain('original\n');
  });

  it('records the flow that wrote the set, and what each entry holds', async () => {
    writeSkill('mango-skills', 'winner\n');
    makeDirectories('claude-skills');

    const { taken, request, entry } = await previewSkill();
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'mango-skills'))]),
      applyDeps()
    );

    const manifest = await readBackupManifest(result.backupId ?? '', backupDeps());
    expect(manifest?.operation).toBe('propagation');
    // One entry per destination, every one naming the resource it holds — the
    // identity the coverage matrix uses, which a slug alone cannot reproduce.
    expect(manifest?.entries.length).toBeGreaterThan(0);
    expect(manifest?.entries.every((backed) => backed.resourceKey === 'skill:gh')).toBe(true);
  });

  /*
    The case an inferred origin gets wrong. Every entry of an apply that only
    overwrote pre-existing files carries a `backupPath` — the exact shape a
    removal produces — so a reader deriving the origin from the entries would
    call this a removal and offer to "put the removed copies back". Undo would
    then restore, which happens to be right here, but the same derivation on an
    apply that created paths would label a delete as a restore.
  */
  it('reports a pure-overwrite apply as propagation, not as the removal it looks like', async () => {
    writeSkill('mango-skills', 'winner\n');
    writeSkill('agents-skills', 'stale-a\n');
    writeSkill('claude-skills', 'stale-b\n');
    writeSkill('cursor-skills', 'stale-c\n');

    const { taken, request, entry } = await previewSkill();
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'mango-skills'))]),
      applyDeps()
    );

    const manifest = await readBackupManifest(result.backupId ?? '', backupDeps());
    expect(result.applied.every((item) => item.operation === 'overwrite')).toBe(true);
    expect(manifest?.entries.length).toBeGreaterThan(0);
    expect(manifest?.entries.every((backed) => backed.backupPath !== undefined)).toBe(true);
    expect(manifest?.operation).toBe('propagation');
  });
});

describe('propagation apply — all-or-nothing', () => {
  /** Fails the write aimed at one location, after earlier ones have landed. */
  function failingAt(locationId: LibraryLocationId): Partial<PropagationApplyDeps> {
    return applyDeps({
      writeDirectory: (input) => {
        if (input.locationId === locationId) {
          return Promise.reject(new Error('disk full'));
        }
        return writeDirectoryResource(input, writerOverrides());
      },
    });
  }

  it('restores every destination when a later write fails', async () => {
    writeSkill('mango-skills', 'winner\n');
    writeSkill('agents-skills', 'first-original\n');
    writeSkill('claude-skills', 'second-original\n');
    makeDirectories('cursor-skills');

    const { taken, request, entry } = await previewSkill();
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'mango-skills'))]),
      failingAt('cursor-skills')
    );

    expect(result.partial).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ locationId: 'cursor-skills', reason: 'write-failed' });
    // Every destination is byte-identical to its pre-apply state.
    expect(readSkill('agents-skills')).toContain('first-original\n');
    expect(readSkill('claude-skills')).toContain('second-original\n');
    expect(readSkill('mango-skills')).toContain('winner\n');
  });

  it('leaves no partially written skill directory behind', async () => {
    writeSkill('mango-skills', 'winner\n');
    makeDirectories('claude-skills', 'cursor-skills');

    const { taken, request, entry } = await previewSkill();
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'mango-skills'))]),
      failingAt('cursor-skills')
    );

    expect(result.partial).toBe(false);
    // The claude write succeeded and was then compensated by removal, because
    // the apply created it rather than replacing anything.
    expect(() => readSkill('claude-skills')).toThrow();
    expect(() => readSkill('cursor-skills')).toThrow();
  });

  it('treats a post-write hash mismatch as a failure and rolls back', async () => {
    writeSkill('mango-skills', 'winner\n');
    writeSkill('claude-skills', 'original\n');

    const { taken, request, entry } = await previewSkill();
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'mango-skills'))]),
      applyDeps({ hashAt: () => Promise.resolve('a-hash-nothing-produces') })
    );

    expect(result.applied).toEqual([]);
    expect(result.failed[0]).toMatchObject({ reason: 'verification-failed' });
    expect(result.partial).toBe(false);
    expect(readSkill('claude-skills')).toContain('original\n');
  });
});

describe('propagation undo', () => {
  it('restores overwritten content and removes what the apply created', async () => {
    writeSkill('mango-skills', 'winner\n');
    writeSkill('claude-skills', 'original\n');
    makeDirectories('cursor-skills');

    const { taken, request, entry } = await previewSkill();
    const applied = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'mango-skills'))]),
      applyDeps()
    );
    expect(applied.backupId).toBeDefined();

    const undone = await undoLibraryPropagation(applied.backupId ?? '', {
      backup: backupDeps(),
      pathEnv,
      writeEngine: 'in-process',
    });

    expect(undone.restored.map((item) => item.locationId)).toEqual(['claude-skills']);
    expect(undone.removed.map((item) => item.locationId).sort()).toEqual([
      'agents-skills',
      'cursor-skills',
    ]);
    expect(readSkill('claude-skills')).toContain('original\n');
    expect(() => readSkill('cursor-skills')).toThrow();
  });

  it('leaves a destination alone when it changed after the apply', async () => {
    writeSkill('mango-skills', 'winner\n');
    writeSkill('claude-skills', 'original\n');

    const { taken, request, entry } = await previewSkill();
    const applied = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'mango-skills'))]),
      applyDeps()
    );

    // Undoing an apply must not also discard an edit made afterwards.
    writeSkill('claude-skills', 'edited after the apply\n');
    const undone = await undoLibraryPropagation(applied.backupId ?? '', {
      backup: backupDeps(),
      pathEnv,
      writeEngine: 'in-process',
    });

    expect(undone.restored).toEqual([]);
    expect(undone.skipped[0]).toMatchObject({ reason: 'changed-since-apply' });
    expect(readSkill('claude-skills')).toContain('edited after the apply\n');
  });

  it('reports a backup that retention has already discarded', async () => {
    await expect(
      undoLibraryPropagation('2020-01-01T00-00-00.000Z-deadbeef', {
        backup: backupDeps(),
        pathEnv,
        writeEngine: 'in-process',
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('propagation apply — file-backed resources', () => {
  async function previewInstruction() {
    const request: PropagationPreviewRequest = {
      resourceKeys: ['instruction:global'],
      targetLocationIds: [...INSTRUCTION_LOCATIONS],
    };
    const taken = await preview(request);
    return { taken, request, entry: onlyEntry(taken) };
  }

  it('propagates a single-file instruction to its peers', async () => {
    writeInstruction('claude-instructions', '# House rules\n');
    mkdirSync(join(home, '.mango'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });

    const { taken, request, entry } = await previewInstruction();
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'claude-instructions'))]),
      applyDeps()
    );

    expect(result.failed).toEqual([]);
    expect(readFileSync(instructionPath('mango-instructions'), 'utf8')).toBe('# House rules\n');
    expect(readFileSync(instructionPath('codex-instructions'), 'utf8')).toBe('# House rules\n');
  });

  it('sends one copy of the bytes however many destinations share them', async () => {
    writeInstruction('claude-instructions', '# House rules\n');
    mkdirSync(join(home, '.mango'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });

    const { taken, request, entry } = await previewInstruction();
    let sent: RuntimeLibraryApplyParams | undefined;
    await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'claude-instructions'))]),
      applyDeps({
        writeEngine: 'runtime',
        runtimeApply: (params) => {
          sent = params;
          return Promise.resolve({ partial: false, applied: [], skipped: [], failed: [] });
        },
      })
    );

    // Two destinations, identical bytes: one payload in the frame, both
    // operations pointing at it. Inlining per operation is what puts a wide
    // apply over RUNTIME_MAX_FRAME_BYTES.
    const operations = sent?.operations ?? [];
    expect(operations).toHaveLength(2);
    expect(Object.keys(sent?.contents ?? {})).toHaveLength(1);
    const [ref] = Object.keys(sent?.contents ?? {});
    expect(operations.map((operation) => operation.contentRef)).toEqual([ref, ref]);
    expect(Buffer.from(sent?.contents?.[ref ?? ''] ?? '', 'base64').toString('utf8')).toBe(
      '# House rules\n'
    );
  });

  it('mechanically adapts plain instructions to MDC before the atomic write', async () => {
    writeInstruction('claude-instructions', '\uFEFF# House rules\r\n\r\nKeep changes focused.\r\n');
    mkdirSync(join(home, '.cursor', 'rules'), { recursive: true });
    const request: PropagationPreviewRequest = {
      resourceKeys: ['instruction:global'],
      targetLocationIds: ['cursor-rules'],
    };
    const taken = await preview(request);
    const entry = onlyEntry(taken);

    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        adoptAll(entry, winnerFrom(entry, 'claude-instructions'), [], 'mechanical'),
      ]),
      applyDeps()
    );

    expect(result.failed).toEqual([]);
    expect(readFileSync(instructionPath('cursor-rules'), 'utf8')).toBe(
      '---\ndescription: "House rules"\nalwaysApply: true\n---\n\n\uFEFF# House rules\r\n\r\nKeep changes focused.\r\n'
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
  });

  it('requires an explicit strategy before adapting a destination', async () => {
    writeInstruction('claude-instructions', '# House rules\n');
    mkdirSync(join(home, '.cursor', 'rules'), { recursive: true });
    const request: PropagationPreviewRequest = {
      resourceKeys: ['instruction:global'],
      targetLocationIds: ['cursor-rules'],
    };
    const taken = await preview(request);
    const entry = onlyEntry(taken);

    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'claude-instructions'))]),
      applyDeps()
    );

    await expect(failure).rejects.toMatchObject({ status: 422 });
    expect(existsSync(instructionPath('cursor-rules'))).toBe(false);
  });

  it('normalizes a Claude subagent into Codex TOML through propagation', async () => {
    writeSubagent(
      'claude-agents',
      '---\nname: "reviewer"\ndescription: "Reviews changes"\ntools:\n  - "Read"\n---\n\nReview carefully.\n'
    );
    mkdirSync(join(home, '.codex', 'agents'), { recursive: true });
    const request: PropagationPreviewRequest = {
      resourceKeys: ['subagent:reviewer'],
      targetLocationIds: ['codex-agents'],
    };
    const taken = await preview(request);
    const entry = onlyEntry(taken);

    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        adoptAll(entry, winnerFrom(entry, 'claude-agents'), [], 'mechanical'),
      ]),
      applyDeps()
    );

    expect(result.failed).toEqual([]);
    expect(readFileSync(subagentPath('codex-agents'), 'utf8')).toBe(
      'name = "reviewer"\ndescription = "Reviews changes"\ndeveloper_instructions = "Review carefully.\\n"\n'
    );
    expect(result.applied[0]?.adaptation).toMatchObject({
      strategy: 'mechanical',
      lossy: true,
      notes: [{ code: 'field-dropped', field: 'tools' }],
    });
  });

  it('does not write adapter failures or return partial output', async () => {
    writeInstruction('claude-instructions', '# House rules\n');
    mkdirSync(join(home, '.cursor', 'rules'), { recursive: true });
    const request: PropagationPreviewRequest = {
      resourceKeys: ['instruction:global'],
      targetLocationIds: ['cursor-rules'],
    };
    const taken = await preview(request);
    const entry = onlyEntry(taken);

    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        adoptAll(entry, winnerFrom(entry, 'claude-instructions'), [], 'mechanical'),
      ]),
      applyDeps({
        adapt: () =>
          Promise.resolve({
            ok: false,
            error: { code: 'provider-failed', message: 'connector unavailable' },
          }),
      })
    );

    expect(result).toMatchObject({
      partial: false,
      applied: [],
      failed: [{ locationId: 'cursor-rules', reason: 'adaptation-failed' }],
    });
    expect(existsSync(instructionPath('cursor-rules'))).toBe(false);
  });

  it('adopts edited bytes that exist in no location yet', async () => {
    writeInstruction('claude-instructions', '# Original\n');
    writeInstruction('codex-instructions', '# Different\n');
    mkdirSync(join(home, '.mango'), { recursive: true });

    const { taken, request, entry } = await previewInstruction();
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        {
          resourceKey: entry.resourceKey,
          resolution: 'edit-then-adopt',
          editedContent: '# Merged by hand\n',
          destinations: entry.destinations.map((destination) => ({
            locationId: destination.locationId,
            action: 'apply' as const,
          })),
        },
      ]),
      applyDeps()
    );

    expect(result.failed).toEqual([]);
    for (const locationId of INSTRUCTION_LOCATIONS) {
      expect(readFileSync(instructionPath(locationId), 'utf8')).toBe('# Merged by hand\n');
    }
    // One set of bytes everywhere means one hash everywhere.
    expect(new Set(result.applied.map((item) => item.contentHash)).size).toBe(1);
  });

  it('refuses edited text for a directory resource', async () => {
    writeSkill('mango-skills', 'winner\n');
    makeDirectories('claude-skills');

    const { taken, request, entry } = await previewSkill();
    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        {
          resourceKey: entry.resourceKey,
          resolution: 'edit-then-adopt',
          editedContent: 'not a directory',
          destinations: entry.destinations.map((destination) => ({
            locationId: destination.locationId,
            action: 'apply' as const,
          })),
        },
      ]),
      applyDeps()
    );

    await expect(failure).rejects.toMatchObject({ status: 422 });
  });

  // One hand-merged file is one set of bytes with no adapter behind it, so
  // fanning it into a differently-formatted location would write text that
  // location's reader cannot parse — the case `adopt-group` reports blocked.
  it('refuses to fan one edit into destinations of differing formats', async () => {
    writeInstruction('claude-instructions', '# Original\n');
    mkdirSync(join(home, '.cursor', 'rules'), { recursive: true });

    const request: PropagationPreviewRequest = {
      resourceKeys: ['instruction:global'],
      targetLocationIds: [...INSTRUCTION_LOCATIONS, 'cursor-rules'],
    };
    const taken = await preview(request);
    const entry = onlyEntry(taken);

    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        {
          resourceKey: entry.resourceKey,
          resolution: 'edit-then-adopt',
          editedContent: '# Merged by hand\n',
          destinations: entry.destinations.map((destination) => ({
            locationId: destination.locationId,
            action: 'apply' as const,
          })),
        },
      ]),
      applyDeps()
    );

    expect(entry.destinations.map((destination) => destination.locationId)).toContain(
      'cursor-rules'
    );
    await expect(failure).rejects.toThrow(/destinations of differing formats/);
    expect(existsSync(join(home, '.cursor', 'rules', 'global.mdc'))).toBe(false);
  });
});

describe('propagation apply — request validation', () => {
  // A location the scanner skips reports every destination as `create`, so an
  // apply would overwrite real content while the preview claimed there was none.
  it('refuses to preview a location the user has not enabled', async () => {
    writeInstruction('claude-instructions', '# House rules\n');

    const env = pathEnv();
    const failure = previewLibraryPropagation(
      userId(),
      { resourceKeys: ['instruction:global'], targetLocationIds: [...INSTRUCTION_LOCATIONS] },
      {
        discover: (scanUserId, kinds) =>
          discoverLibraryResources(getDb(), scanUserId, {
            force: true,
            kinds,
            cache: new LibraryCache(),
            pathEnv: env,
            settings: settings([...INSTRUCTION_LOCATIONS]),
          }),
        describeLocation: (id) => describeLocation(id, env),
        enabledLocationIds: async () =>
          enabledLibraryLocations(libraryLocationsFor(settings(['claude-instructions'])), 'home'),
      }
    );

    await expect(failure).rejects.toMatchObject({ status: 422 });
  });
});

describe('propagation apply — decisions', () => {
  it('refuses to apply a divergent resource with no winner named', async () => {
    writeSkill('mango-skills', 'mine\n');
    writeSkill('claude-skills', 'theirs\n');
    makeDirectories('cursor-skills');

    const { taken, request, entry } = await previewSkill();
    expect(entry.requiresWinnerSelection).toBe(true);

    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        {
          resourceKey: entry.resourceKey,
          resolution: 'adopt-group',
          destinations: entry.destinations.map((destination) => ({
            locationId: destination.locationId,
            action: 'apply' as const,
          })),
        },
      ]),
      applyDeps()
    );

    await expect(failure).rejects.toMatchObject({ status: 422 });
    expect(readSkill('claude-skills')).toContain('theirs\n');
  });

  it('rejects a winner that is not a version of the resource', async () => {
    writeSkill('mango-skills', 'mine\n');
    makeDirectories('claude-skills');

    const { taken, request, entry } = await previewSkill();
    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, 'not-a-real-hash')]),
      applyDeps()
    );

    await expect(failure).rejects.toMatchObject({ status: 422 });
  });

  it('records an acknowledgement for keep-per-location and writes nothing', async () => {
    writeSkill('mango-skills', 'mine\n');
    writeSkill('claude-skills', 'theirs\n');

    const { taken, request, entry } = await previewSkill();
    const acknowledged: unknown[] = [];
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        {
          resourceKey: entry.resourceKey,
          resolution: 'keep-per-location',
          destinations: entry.destinations.map((destination) => ({
            locationId: destination.locationId,
            action: 'skip' as const,
          })),
        },
      ]),
      applyDeps({
        acknowledge: (_userId, ack) => {
          acknowledged.push(ack);
          return Promise.resolve(undefined);
        },
      })
    );

    expect(result.applied).toEqual([]);
    expect(result.backupId).toBeUndefined();
    expect(result.skipped[0]).toMatchObject({ reason: 'divergence-acknowledged' });
    expect(acknowledged).toHaveLength(1);
    expect(readSkill('claude-skills')).toContain('theirs\n');
  });

  it('rejects keeping a divergence while also writing somewhere', async () => {
    writeSkill('mango-skills', 'mine\n');
    writeSkill('claude-skills', 'theirs\n');

    const { taken, request, entry } = await previewSkill();
    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        {
          resourceKey: entry.resourceKey,
          resolution: 'keep-per-location',
          destinations: entry.destinations.map((destination) => ({
            locationId: destination.locationId,
            action:
              destination.locationId === 'cursor-skills' ? ('apply' as const) : ('skip' as const),
          })),
        },
      ]),
      applyDeps()
    );

    await expect(failure).rejects.toMatchObject({ status: 422 });
  });

  it('honours a skipped destination', async () => {
    writeSkill('mango-skills', 'winner\n');
    makeDirectories('claude-skills', 'cursor-skills');

    const { taken, request, entry } = await previewSkill();
    const result = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        adoptAll(entry, winnerFrom(entry, 'mango-skills'), ['cursor-skills']),
      ]),
      applyDeps()
    );

    expect(result.skipped).toContainEqual({
      resourceKey: 'skill:gh',
      locationId: 'cursor-skills',
      reason: 'user-skipped',
    });
    expect(() => readSkill('cursor-skills')).toThrow();
    expect(readSkill('claude-skills')).toContain('winner\n');
  });

  it('refuses a decision that leaves an offered destination undecided', async () => {
    writeSkill('mango-skills', 'winner\n');
    makeDirectories('claude-skills', 'cursor-skills');

    const { taken, request, entry } = await previewSkill();
    const decision = adoptAll(entry, winnerFrom(entry, 'mango-skills'));
    const dropped = decision.destinations.at(-1);
    expect(dropped).toBeDefined();

    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        { ...decision, destinations: decision.destinations.slice(0, -1) },
      ]),
      applyDeps()
    );

    await expect(failure).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(`missing "${dropped?.locationId}"`),
    });
    expect(() => readSkill('claude-skills')).toThrow();
  });

  it('refuses two decisions for the same destination', async () => {
    writeSkill('mango-skills', 'winner\n');
    makeDirectories('claude-skills');

    const { taken, request, entry } = await previewSkill();
    const decision = adoptAll(entry, winnerFrom(entry, 'mango-skills'));
    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        {
          ...decision,
          destinations: [
            ...decision.destinations,
            { locationId: 'claude-skills', action: 'skip' as const },
          ],
        },
      ]),
      applyDeps()
    );

    await expect(failure).rejects.toMatchObject({ status: 422 });
    expect(() => readSkill('claude-skills')).toThrow();
  });
});

describe('propagation apply — staleness', () => {
  it('refuses an apply built on a preview taken before a source edit', async () => {
    writeSkill('mango-skills', 'first\n');
    makeDirectories('claude-skills');
    const { taken, request, entry } = await previewSkill();

    writeSkill('mango-skills', 'second\n');
    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'mango-skills'))]),
      applyDeps()
    );

    await expect(failure).rejects.toMatchObject({ status: 409 });
    expect(() => readSkill('claude-skills')).toThrow();
  });

  it('refuses an apply built on a preview taken before a destination edit', async () => {
    writeSkill('mango-skills', 'winner\n');
    writeSkill('claude-skills', 'original\n');
    const { taken, request, entry } = await previewSkill();

    // The destination is what gets clobbered, so a change there is exactly as
    // disqualifying as a change to the source.
    writeSkill('claude-skills', 'someone else was here\n');
    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [adoptAll(entry, winnerFrom(entry, 'mango-skills'))]),
      applyDeps()
    );

    await expect(failure).rejects.toMatchObject({ status: 409 });
    expect(readSkill('claude-skills')).toContain('someone else was here\n');
  });
});

describe('propagation end to end', () => {
  it('takes four diverging locations to uniform through preview, decide, apply', async () => {
    writeSkill('mango-skills', 'a\n');
    writeSkill('agents-skills', 'b\n');
    writeSkill('claude-skills', 'c\n');
    makeDirectories('cursor-skills');

    const before = await previewSkill();
    expect(before.entry.divergence).toBe('divergent');

    const applied: PropagationApply = await applyLibraryPropagation(
      userId(),
      toRequest(before.taken, before.request, [
        adoptAll(before.entry, winnerFrom(before.entry, 'agents-skills')),
      ]),
      applyDeps()
    );
    expect(applied.failed).toEqual([]);

    const after = await previewSkill();
    expect(after.entry.divergence).toBe('uniform');
    expect(after.entry.sourceGroups).toHaveLength(1);
    expect(after.entry.sourceGroups[0]?.instanceCount).toBe(4);
    expect(await listDivergenceAcks(userId())).toEqual([]);
  });
});
