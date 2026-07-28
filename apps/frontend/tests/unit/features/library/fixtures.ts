/**
 * Library test fixtures.
 *
 * Coverage is always built for all four targets in registry order, because the
 * API's resolver does exactly that — a fixture with a partial coverage array
 * would let a matrix bug that drops a column pass unnoticed.
 */

import type {
  LibraryContentGroup,
  LibraryCoverage,
  LibraryInstance,
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryResource,
  LibraryTargetDescriptor,
  LibraryTargetId,
  PropagationDestination,
  PropagationPreview,
  PropagationPreviewEntry,
  PropagationSourceGroup,
} from '@mangostudio/shared/library';

const TARGET_IDS: readonly LibraryTargetId[] = ['mangostudio', 'claude', 'codex', 'cursor'];

function targetDescriptor(
  id: LibraryTargetId,
  skill: LibraryLocationId[]
): LibraryTargetDescriptor {
  return {
    id,
    displayNameKey: `library.targets.${id}`,
    reads: { skill, subagent: [], instruction: [], setting: [], hook: [] },
  };
}

export const TARGETS: readonly LibraryTargetDescriptor[] = [
  targetDescriptor('mangostudio', ['mango-skills', 'agents-skills', 'claude-skills']),
  targetDescriptor('claude', ['claude-skills']),
  targetDescriptor('codex', ['codex-skills', 'agents-skills']),
  targetDescriptor('cursor', ['cursor-skills', 'cursor-skills-builtin']),
];

export function instance(overrides: Partial<LibraryInstance> = {}): LibraryInstance {
  return {
    locationId: 'agents-skills',
    path: '/home/dev/.agents/skills/gh',
    modifiedAtMs: 1_700_000_000_000,
    format: 'markdown-frontmatter',
    valid: true,
    contentHash: 'a3f9c1',
    sizeBytes: 512,
    ...overrides,
  } as LibraryInstance;
}

function coverage(
  targetId: LibraryTargetId,
  overrides: Partial<LibraryCoverage> = {}
): LibraryCoverage {
  return { targetId, state: 'absent', shadowedLocationIds: [], ...overrides };
}

/** Coverage for all four targets, defaulting to absent where unspecified. */
export function fullCoverage(
  entries: Partial<Record<LibraryTargetId, Partial<LibraryCoverage>>> = {}
): LibraryCoverage[] {
  return TARGET_IDS.map((targetId) => coverage(targetId, entries[targetId] ?? {}));
}

function groupsOf(instances: readonly LibraryInstance[]): LibraryContentGroup[] {
  const counts = new Map<string, number>();
  for (const candidate of instances) {
    if (!candidate.valid || !candidate.contentHash) continue;
    counts.set(candidate.contentHash, (counts.get(candidate.contentHash) ?? 0) + 1);
  }
  return [...counts]
    .map(([contentHash, instanceCount]) => ({
      contentHash,
      instanceCount,
      locationIds: instances
        .filter((candidate) => candidate.contentHash === contentHash)
        .map((candidate) => candidate.locationId),
    }))
    .sort((left, right) => right.instanceCount - left.instanceCount);
}

export function resource(overrides: Partial<LibraryResource> = {}): LibraryResource {
  const instances = overrides.instances ?? [instance()];
  return {
    ref: { kind: 'skill', slug: 'gh' },
    key: 'skill:gh',
    instances,
    coverage: fullCoverage(),
    divergence: 'single',
    whitespaceOnlyDivergence: false,
    // Derived from the instances so a fixture cannot describe a resource that
    // discovery could never produce.
    contentGroups: groupsOf(instances),
    ...overrides,
  };
}

export function location(overrides: Partial<LibraryLocationStatus> = {}): LibraryLocationStatus {
  return {
    id: 'agents-skills',
    kind: 'skill',
    path: '/home/dev/.agents/skills',
    access: 'read-write',
    exists: true,
    readable: true,
    writable: true,
    targetIds: ['mangostudio', 'codex'],
    ...overrides,
  };
}

export function sourceGroup(
  overrides: Partial<PropagationSourceGroup> = {}
): PropagationSourceGroup {
  return {
    contentHash: 'a3f9c1',
    locationIds: ['agents-skills'],
    instanceCount: 1,
    formats: ['markdown-frontmatter'],
    newestModifiedAtMs: 1_700_000_000_000,
    sizeBytes: 512,
    contentLocationId: 'agents-skills',
    contentPath: '/home/dev/.agents/skills/gh',
    ...overrides,
  };
}

export function destination(
  overrides: Partial<PropagationDestination> = {}
): PropagationDestination {
  return {
    locationId: 'agents-skills',
    targetIds: ['mangostudio', 'codex'],
    toFormat: 'markdown-frontmatter',
    path: '/home/dev/.agents/skills',
    outcomes: [{ winnerContentHash: 'a3f9c1', operation: 'create' }],
    ...overrides,
  };
}

export function previewEntry(
  overrides: Partial<PropagationPreviewEntry> = {}
): PropagationPreviewEntry {
  const sourceGroups = overrides.sourceGroups ?? [sourceGroup()];
  return {
    resourceKey: 'skill:gh',
    ref: { kind: 'skill', slug: 'gh' },
    divergence: 'single',
    sourceGroups,
    requiresWinnerSelection: sourceGroups.length > 1,
    acknowledgedDivergence: false,
    destinations: [destination()],
    ...overrides,
  };
}

export function preview(entries: PropagationPreviewEntry[] = [previewEntry()]): PropagationPreview {
  return { previewToken: 'token', stateHash: 'state', entries };
}
