import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_APP_SETTINGS,
  libraryLocationsFor,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import type {
  LibraryLocationId,
  LibraryResource,
  PropagationApplyRequest,
  PropagationDecision,
  PropagationPreview,
  PropagationPreviewEntry,
  PropagationPreviewRequest,
} from '@mangostudio/shared/library';
import { directoryHashDomainVersion, enabledLibraryLocations } from '@mangostudio/shared/library';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import type { RuntimeLibraryApplyParams } from '@mangostudio/shared/runtime-contract';
import { getDb } from '../../../src/db/database';
import { listDivergenceAcks } from '../../../src/modules/library/application/conflict-resolution';
import { discoverLibraryResources } from '../../../src/modules/library/application/library-discovery';
import {
  applyLibraryPropagation,
  type PropagationApplyDeps,
} from '../../../src/modules/library/application/propagation-apply';
import { previewLibraryPropagation } from '../../../src/modules/library/application/propagation-preview';
import { LibraryCache } from '../../../src/modules/library/infrastructure/library-cache';
import {
  createLibraryPathEnv,
  describeLocation,
} from '../../../src/modules/library/infrastructure/location-probe';
import { refuseLibraryApply } from '../../support/mocks/refusing-library-runtime';

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
const COMMAND_LOCATIONS: readonly LibraryLocationId[] = ['claude-commands', 'codex-prompts'];

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

let home: string;
let userSeq = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mango-apply-'));
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
    ...COMMAND_LOCATIONS,
    'cursor-rules',
  ]);
  return previewLibraryPropagation(userId(), request, {
    snapshot: async (scanUserId, environmentId, kinds) => ({
      environmentId,
      resources: (
        await discoverLibraryResources(getDb(), scanUserId, {
          force: true,
          kinds,
          cache,
          pathEnv: env,
          settings: enabled,
        })
      ).resources,
      statuses: new Map(
        request.targetLocationIds.map((id) => [id, describeLocation(id, env)] as const)
      ),
      directoryHashDomain: directoryHashDomainVersion(),
    }),
    enabledLocationIds: async () => enabledLibraryLocations(libraryLocationsFor(enabled), 'home'),
  });
}

/**
 * The Hub's planning and validation over a temp home. Every case here is
 * refused, or writes nothing, before a machine is reached; the writes
 * themselves run against the real runtime in
 * `rust-runtime-library-propagation.integration.test.ts`.
 */
function applyDeps(overrides: Partial<PropagationApplyDeps> = {}): Partial<PropagationApplyDeps> {
  return {
    preview: (_userId, request) => preview(request),
    pathEnv,
    runtimeApply: refuseLibraryApply,
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
      environmentId: destination.environmentId,
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

describe('propagation apply — file-backed resources', () => {
  async function previewInstruction() {
    const request: PropagationPreviewRequest = {
      resourceKeys: ['instruction:global'],
      targetLocationIds: [...INSTRUCTION_LOCATIONS],
    };
    const taken = await preview(request);
    return { taken, request, entry: onlyEntry(taken) };
  }

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
        runtimeApply: (params) => {
          sent = params;
          return Promise.resolve({
            partial: false,
            applied: [],
            skipped: [],
            failed: [],
            backups: [],
          });
        },
      })
    );

    // Two destinations, identical bytes: one payload in the frame, both
    // operations pointing at it. Inlining per operation is what puts a wide
    // apply over DEFAULT_MAX_FRAME_BYTES.
    const operations = sent?.operations ?? [];
    expect(operations).toHaveLength(2);
    expect(Object.keys(sent?.contents ?? {})).toHaveLength(1);
    const [ref] = Object.keys(sent?.contents ?? {});
    expect(operations.map((operation) => operation.contentRef)).toEqual([ref, ref]);
    expect(Buffer.from(sent?.contents?.[ref ?? ''] ?? '', 'base64').toString('utf8')).toBe(
      '# House rules\n'
    );
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

/**
 * `claude-commands` and `codex-prompts` are both `markdown-frontmatter`, so a
 * copy between them never needs a format conversion — the same shape that
 * makes a same-vendor skill copy a plain byte copy. This is the "propagate
 * once, stays in sync" path end to end: preview, apply, and a fresh rescan
 * confirming the two vendors read as one resource afterwards.
 */

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
        snapshot: async (scanUserId, environmentId, kinds) => ({
          environmentId,
          resources: (
            await discoverLibraryResources(getDb(), scanUserId, {
              force: true,
              kinds,
              cache: new LibraryCache(),
              pathEnv: env,
              settings: settings([...INSTRUCTION_LOCATIONS]),
            })
          ).resources,
          statuses: new Map(
            INSTRUCTION_LOCATIONS.map((id) => [id, describeLocation(id, env)] as const)
          ),
          directoryHashDomain: directoryHashDomainVersion(),
        }),
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

  it('refuses keeping a non-divergent resource before any other decision is written', async () => {
    // `gh` would be written to claude-skills; `other` has one version, so there is
    // no divergence to keep. The refusal has to come from planning, ahead of every
    // write, because an acknowledgement error after the writes cannot be undone.
    writeSkill('mango-skills', 'mine\n');
    makeDirectories('claude-skills');
    const otherDir = join(home, '.mango', 'skills', 'other');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'SKILL.md'), '---\nname: other\ndescription: Other\n---\nsolo\n');

    const request: PropagationPreviewRequest = {
      resourceKeys: ['skill:gh', 'skill:other'],
      targetLocationIds: ['claude-skills'],
    };
    const taken = await preview(request);
    const [gh, other] = [...taken.entries].sort((a, b) =>
      a.resourceKey.localeCompare(b.resourceKey)
    );
    if (!gh || !other)
      throw new Error(`Expected two preview entries, received ${taken.entries.length}.`);

    const writes: RuntimeLibraryApplyParams[] = [];
    const acknowledged: unknown[] = [];
    const failure = applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        adoptAll(gh, winnerFrom(gh, 'mango-skills')),
        {
          resourceKey: other.resourceKey,
          resolution: 'keep-per-location',
          destinations: other.destinations.map((destination) => ({
            environmentId: destination.environmentId,
            locationId: destination.locationId,
            action: 'skip' as const,
          })),
        },
      ]),
      applyDeps({
        runtimeApply: (params) => {
          writes.push(params);
          return refuseLibraryApply(params);
        },
        acknowledge: (_userId, ack) => {
          acknowledged.push(ack);
          return Promise.resolve(undefined);
        },
      })
    );

    await expect(failure).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('"skill:other" is not divergent'),
    });
    expect({ writes: writes.length, acknowledged: acknowledged.length }).toEqual({
      writes: 0,
      acknowledged: 0,
    });
    expect(existsSync(skillPath('claude-skills'))).toBe(false);
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

/**
 * A skill that exists on remote machines only. Nothing on this host's disk holds
 * it, so anything that verifies a divergence by scanning the hub cannot find it.
 */
const REMOTE_SKILL_KEY = 'skill:remote-only-divergence';
const REMOTE_SKILL_SLUG = 'remote-only-divergence';

/** What a remote runtime reports for the skill: one readable copy per `[location, hash]`. */
function remoteScan(copies: readonly (readonly [LibraryLocationId, string])[]): LibraryResource[] {
  return [
    {
      ref: { kind: 'skill', slug: REMOTE_SKILL_SLUG },
      key: REMOTE_SKILL_KEY,
      instances: copies.map(([locationId, contentHash]) => ({
        locationId,
        path: `/srv/home/${locationId}/${REMOTE_SKILL_SLUG}`,
        modifiedAtMs: 1,
        format: 'markdown-frontmatter' as const,
        valid: true as const,
        contentHash,
        sizeBytes: 4,
      })),
      coverage: [],
      divergence: 'divergent',
      whitespaceOnlyDivergence: false,
      contentGroups: [],
    },
  ];
}

const REMOTE_MACHINES: Record<string, readonly (readonly [LibraryLocationId, string])[]> = {
  'box-a': [
    ['claude-skills', 'hash-on-box-a-claude'],
    ['agents-skills', 'hash-on-box-a-agents'],
  ],
  'box-b': [['claude-skills', 'hash-on-box-b']],
};

/** A preview over machines that report their own copies through their own runtimes. */
function previewRemoteMachines(
  request: PropagationPreviewRequest,
  hashDomains: Readonly<Record<string, number>> = {}
): Promise<PropagationPreview> {
  const env = pathEnv();
  const enabled = settings(SKILL_LOCATIONS);
  return previewLibraryPropagation(userId(), request, {
    snapshot: async (_userId, environmentId) => ({
      environmentId,
      resources: remoteScan(REMOTE_MACHINES[environmentId] ?? []),
      statuses: new Map(
        request.targetLocationIds.map((id) => [id, describeLocation(id, env)] as const)
      ),
      directoryHashDomain: hashDomains[environmentId] ?? directoryHashDomainVersion(),
    }),
    enabledLocationIds: async () => enabledLibraryLocations(libraryLocationsFor(enabled), 'home'),
  });
}

describe('propagation apply — keeping a divergence across machines', () => {
  /** Keeps the divergence over `environmentIds`, with the real acknowledgement path. */
  async function keepDivergence(
    environmentIds: readonly string[],
    hashDomains: Readonly<Record<string, number>> = {}
  ) {
    const request: PropagationPreviewRequest = {
      resourceKeys: [REMOTE_SKILL_KEY],
      targetLocationIds: ['claude-skills', 'agents-skills'],
      environmentIds: [...environmentIds],
    };
    const taken = await previewRemoteMachines(request, hashDomains);
    const entry = onlyEntry(taken);
    const reviewed = entry.sourceGroups.map((group) => group.contentHash).sort();

    // Only the writes are stubbed; verification and storage are the real ones.
    const outcome = await applyLibraryPropagation(
      userId(),
      toRequest(taken, request, [
        {
          resourceKey: entry.resourceKey,
          resolution: 'keep-per-location',
          destinations: entry.destinations.map((destination) => ({
            environmentId: destination.environmentId,
            locationId: destination.locationId,
            action: 'skip' as const,
          })),
        },
      ]),
      applyDeps({ preview: (_userId, requested) => previewRemoteMachines(requested, hashDomains) })
    ).then(
      () => 'applied',
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`
    );

    const stored = (await listDivergenceAcks(userId())).map((ack) => ({
      resourceKey: ack.resourceKey,
      contentHashes: [...ack.contentHashes].sort(),
    }));
    return { outcome, stored, reviewed };
  }

  it('records two differing copies that one remote machine holds', async () => {
    const { outcome, stored, reviewed } = await keepDivergence(['box-a']);

    expect(reviewed).toHaveLength(2);
    expect({ outcome, stored }).toEqual({
      outcome: 'applied',
      stored: [{ resourceKey: REMOTE_SKILL_KEY, contentHashes: reviewed }],
    });
  });

  it('records the versions the preview read from every machine', async () => {
    const { outcome, stored, reviewed } = await keepDivergence(['box-a', 'box-b']);

    expect(reviewed).toHaveLength(3);
    expect({ outcome, stored }).toEqual({
      outcome: 'applied',
      stored: [{ resourceKey: REMOTE_SKILL_KEY, contentHashes: reviewed }],
    });
  });

  it('refuses to keep hashes that runtimes computed in different directory domains', async () => {
    // Distinct hashes across directory-hash domains do not prove distinct content,
    // so the preview calls the skill incomparable and there is nothing to keep.
    const hashDomains = { 'box-a': directoryHashDomainVersion(), 'box-b': 1 };
    const { outcome, stored } = await keepDivergence(['box-a', 'box-b'], hashDomains);

    expect({ outcome, stored }).toEqual({
      outcome: `rejected: "${REMOTE_SKILL_KEY}" has no comparable divergence to keep: expected divergence "divergent", received "incomparable".`,
      stored: [],
    });
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

/*
  Two machines, two homes, one hub.

  Both are driven in process against their own temp directory, which is exactly
  what makes the interesting failures reachable: a write landing in the wrong
  home, a backup on the wrong disk, or a second write to the same physical home
  clobbering the first. The engine cannot tell these apart from a single-machine
  apply on its own — only the hub's per-machine dispatch can.
*/
