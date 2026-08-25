import { describe, expect, it } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import type { Environment } from '@mangostudio/shared/environments';
import type { GitRepoState, GitSummary } from '@mangostudio/shared/git';
import { en, ptBR } from '@mangostudio/shared/i18n';
import type { LibraryCoverage, LibraryResource } from '@mangostudio/shared/library';
import { createMockChat } from '@mangostudio/shared/test-utils';
import { environmentAlerts } from '../../../../src/features/home/lib/environment-health';
import { greetingSlot } from '../../../../src/features/home/lib/greeting';
import {
  PROMPT_STARTER_IDS,
  promptStarterIds,
  starterContext,
} from '../../../../src/features/home/lib/prompt-starters';
import { summarizeSkillsDivergence } from '../../../../src/features/home/lib/skills-divergence';
import {
  UNCOMMITTED_WORK_LIMIT,
  uncommittedWork,
} from '../../../../src/features/home/lib/uncommitted-work';

function at(hour: number): Date {
  const date = new Date(2026, 7, 24, hour, 30, 0);
  return date;
}

describe('greetingSlot', () => {
  it('splits the day at 05:00, 12:00 and 18:00 in local time', () => {
    expect(greetingSlot(at(4))).toBe('evening');
    expect(greetingSlot(at(5))).toBe('morning');
    expect(greetingSlot(at(11))).toBe('morning');
    expect(greetingSlot(at(12))).toBe('afternoon');
    expect(greetingSlot(at(17))).toBe('afternoon');
    expect(greetingSlot(at(18))).toBe('evening');
    expect(greetingSlot(at(23))).toBe('evening');
  });
});

function repoState(overrides: { clean: boolean; branch: string | null }): GitRepoState {
  return {
    state: 'repo',
    workdir: '/srv/projects/mango',
    root: '/srv/projects/mango',
    status: {
      branch: { name: overrides.branch, ahead: 0, behind: 0 },
      staged: [],
      unstaged: overrides.clean ? [] : [{ path: 'a.ts', status: 'modified' }],
      untracked: [],
      conflicted: [],
      clean: overrides.clean,
    },
  };
}

describe('prompt starters', () => {
  it('offers repository prompts only when there is a repository to talk about', () => {
    expect(starterContext(undefined)).toBe('none');
    expect(starterContext({ state: 'no-workdir' })).toBe('none');
    expect(starterContext({ state: 'not-a-repo', workdir: '/tmp/x' })).toBe('none');
    expect(starterContext(repoState({ clean: false, branch: 'main' }))).toBe('dirty');
    expect(starterContext(repoState({ clean: true, branch: 'main' }))).toBe('branch');
    // Detached HEAD: clean, but there is no branch to summarize.
    expect(starterContext(repoState({ clean: true, branch: null }))).toBe('repo');
  });

  it('never suggests summarizing a branch that does not exist', () => {
    expect(promptStarterIds('repo')).not.toContain('branchSummary');
    expect(promptStarterIds('none')).not.toContain('branchSummary');
    expect(promptStarterIds('branch')).toContain('branchSummary');
  });

  it('has a string in both locales for every starter id', () => {
    for (const id of PROMPT_STARTER_IDS) {
      expect(en.home.starters[id]).toBeTruthy();
      expect(ptBR.home.starters[id]).toBeTruthy();
    }
  });
});

function coverage(targetId: LibraryCoverage['targetId'], locationId?: string): LibraryCoverage {
  return locationId
    ? { targetId, state: 'present', effectiveLocationId: locationId, shadowedLocationIds: [] }
    : { targetId, state: 'absent', shadowedLocationIds: [] };
}

function instance(locationId: string, contentHash: string) {
  return {
    locationId,
    path: `/home/u/${locationId}/frontend-design/SKILL.md`,
    modifiedAtMs: 1,
    format: 'markdown-frontmatter' as const,
    valid: true as const,
    contentHash,
    sizeBytes: 10,
  };
}

/** Two harnesses on one hash, one on another — a real majority. */
function divergentSkill(): LibraryResource {
  return {
    ref: { kind: 'skill', slug: 'frontend-design' },
    key: 'skill:frontend-design',
    instances: [
      instance('claude-home', 'aaa'),
      instance('codex-home', 'aaa'),
      instance('cursor-home', 'bbb'),
    ],
    coverage: [
      coverage('claude', 'claude-home'),
      coverage('codex', 'codex-home'),
      coverage('cursor', 'cursor-home'),
      coverage('mangostudio'),
    ],
    divergence: 'divergent',
    whitespaceOnlyDivergence: false,
    contentGroups: [
      { contentHash: 'aaa', locationIds: ['claude-home', 'codex-home'], instanceCount: 2 },
      { contentHash: 'bbb', locationIds: ['cursor-home'], instanceCount: 1 },
    ],
  };
}

function singleTargetSkill(slug: string): LibraryResource {
  return {
    ref: { kind: 'skill', slug },
    key: `skill:${slug}`,
    instances: [instance('claude-home', 'ccc')],
    coverage: [
      coverage('claude', 'claude-home'),
      coverage('codex'),
      coverage('cursor'),
      coverage('mangostudio'),
    ],
    divergence: 'single',
    whitespaceOnlyDivergence: false,
    contentGroups: [{ contentHash: 'ccc', locationIds: ['claude-home'], instanceCount: 1 }],
  };
}

describe('summarizeSkillsDivergence', () => {
  it('names the outlier and who it disagrees with', () => {
    const summary = summarizeSkillsDivergence([divergentSkill()]);
    expect(summary.headline).toEqual({
      key: 'skill:frontend-design',
      slug: 'frontend-design',
      outliers: ['cursor'],
      agreeing: ['claude', 'codex'],
    });
    expect(summary.divergentCount).toBe(1);
  });

  it('counts single-harness skills without treating them as divergence', () => {
    const summary = summarizeSkillsDivergence([
      singleTargetSkill('deploy-notes'),
      singleTargetSkill('release-checklist'),
    ]);
    expect(summary.headline).toBeNull();
    expect(summary.divergentCount).toBe(0);
    expect(summary.singleTargetCount).toBe(2);
  });

  it('picks a stable headline regardless of scan order', () => {
    const renamed = (slug: string): LibraryResource => ({
      ...divergentSkill(),
      key: `skill:${slug}`,
      ref: { kind: 'skill', slug },
    });
    const alpha = renamed('alpha');
    const zeta = renamed('zeta');
    expect(summarizeSkillsDivergence([zeta, alpha]).headline?.slug).toBe('alpha');
    expect(summarizeSkillsDivergence([alpha, zeta]).headline?.slug).toBe('alpha');
  });
});

function environment(
  overrides: Partial<Environment> & Pick<Environment, 'id' | 'status'>
): Environment {
  return {
    name: overrides.id,
    transportKind: 'ssh',
    config: {},
    enabled: true,
    allowInstalls: false,
    virtual: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('environmentAlerts', () => {
  it('reports faults, and offline machines only when this chat runs on one', () => {
    const environments = [
      environment({ id: 'local', status: { state: 'connected' } }),
      environment({ id: 'idle-box', status: { state: 'disconnected' } }),
      environment({
        id: 'broken-box',
        status: { state: 'error', errorCode: 'RUNTIME_UNAVAILABLE' },
      }),
      environment({ id: 'waking-box', status: { state: 'connecting' } }),
    ];

    // An idle remote nobody is using is its resting state, not an alert.
    expect(environmentAlerts(environments, 'local').map((alert) => alert.environmentId)).toEqual([
      'broken-box',
    ]);

    // The same machine, once the chat is pointed at it, is what blocks the turn.
    expect(environmentAlerts(environments, 'idle-box').map((alert) => alert.environmentId)).toEqual(
      ['broken-box', 'idle-box']
    );
  });

  it('stays quiet about disabled environments', () => {
    const environments = [
      environment({ id: 'retired', enabled: false, status: { state: 'error' } }),
    ];
    expect(environmentAlerts(environments, null)).toEqual([]);
  });
});

/**
 * Only the fields these helpers read are named; everything else comes from the
 * shared factory, so a new `Chat` field does not have to be added here too.
 * The timestamps are fixed rather than faker's `now` because the uncommitted
 * work list is ordered by them.
 */
function chat(id: string, title = id): Chat {
  return createMockChat({
    id,
    title,
    createdAt: 1,
    updatedAt: 1,
    textModel: null,
    imageModel: null,
    workdir: '/srv/projects/mango',
  });
}

function summary(overrides: Partial<GitSummary> = {}): GitSummary {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    changedFileCount: 0,
    workdir: '/srv/projects/mango',
    ...overrides,
  };
}

describe('uncommittedWork', () => {
  it('counts unpushed commits as work left behind, not just a dirty tree', () => {
    const work = uncommittedWork(
      [chat('a'), chat('b'), chat('c')],
      {
        a: summary({ changedFileCount: 3 }),
        b: summary({ ahead: 2 }),
        c: summary(),
      },
      null
    );
    expect(work.rows.map((row) => row.chatId)).toEqual(['a', 'b']);
  });

  it('leaves out the chat the user is already looking at', () => {
    const work = uncommittedWork(
      [chat('a'), chat('b')],
      { a: summary({ changedFileCount: 1 }), b: summary({ changedFileCount: 1 }) },
      'a'
    );
    expect(work.rows.map((row) => row.chatId)).toEqual(['b']);
  });

  it('caps the list and says how much it is not showing', () => {
    const chats = Array.from({ length: UNCOMMITTED_WORK_LIMIT + 3 }, (_, index) =>
      chat(`chat-${index}`)
    );
    const summaries = Object.fromEntries(
      chats.map((entry) => [entry.id, summary({ changedFileCount: 1 })])
    );
    const work = uncommittedWork(chats, summaries, null);
    expect(work.rows).toHaveLength(UNCOMMITTED_WORK_LIMIT);
    expect(work.overflowCount).toBe(3);
  });

  it('ignores chats the batched endpoint had no answer for', () => {
    const work = uncommittedWork([chat('a'), chat('b')], { a: null }, null);
    expect(work.rows).toEqual([]);
    expect(work.overflowCount).toBe(0);
  });
});
