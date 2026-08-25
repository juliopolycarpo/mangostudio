import { describe, expect, it } from 'bun:test';
import type {
  PropagationApplied,
  PropagationPreview,
  PropagationPreviewEntry,
} from '@mangostudio/shared/library';
import { summarizeAppliedResources } from '../../../../src/modules/library/domain/applied-resource-summary';

function entry(overrides: Partial<PropagationPreviewEntry> = {}): PropagationPreviewEntry {
  return {
    resourceKey: 'skill:gh',
    ref: { kind: 'skill', slug: 'gh' },
    divergence: 'uniform',
    sourceGroups: [],
    requiresWinnerSelection: false,
    acknowledgedDivergence: false,
    destinations: [],
    ...overrides,
  };
}

function applied(overrides: Partial<PropagationApplied> = {}): PropagationApplied {
  return {
    resourceKey: 'skill:gh',
    environmentId: 'local',
    locationId: 'claude-skills',
    operation: 'create',
    destinationPath: '/home/user/.claude/skills/gh/SKILL.md',
    contentHash: 'hash-1',
    ...overrides,
  };
}

describe('summarizeAppliedResources', () => {
  it('yields both targets a shared location serves', () => {
    const preview: PropagationPreview = {
      previewToken: 'token',
      stateHash: 'hash',
      entries: [
        entry({
          destinations: [
            {
              environmentId: 'local',
              locationId: 'claude-skills',
              targetIds: ['claude', 'mangostudio'],
              toFormat: 'markdown-frontmatter',
              path: '/home/user/.claude/skills/gh/SKILL.md',
              outcomes: [],
            },
          ],
        }),
      ],
    };
    const writeResult = [applied()];

    const summaries = summarizeAppliedResources(preview, writeResult);

    expect(summaries).toEqual([
      { kind: 'skill', slug: 'gh', targets: ['claude', 'mangostudio'], environmentId: 'local' },
    ]);
  });

  it('omits a resource with no applied rows', () => {
    const preview: PropagationPreview = {
      previewToken: 'token',
      stateHash: 'hash',
      entries: [
        entry({ resourceKey: 'skill:untouched', ref: { kind: 'skill', slug: 'untouched' } }),
      ],
    };

    const summaries = summarizeAppliedResources(preview, []);

    expect(summaries).toEqual([]);
  });

  it('orders summaries by the preview entry order', () => {
    const preview: PropagationPreview = {
      previewToken: 'token',
      stateHash: 'hash',
      entries: [
        entry({
          resourceKey: 'skill:second',
          ref: { kind: 'skill', slug: 'second' },
          destinations: [
            {
              environmentId: 'local',
              locationId: 'claude-skills',
              targetIds: ['claude'],
              toFormat: 'markdown-frontmatter',
              path: '/path/second',
              outcomes: [],
            },
          ],
        }),
        entry({
          resourceKey: 'skill:first',
          ref: { kind: 'skill', slug: 'first' },
          destinations: [
            {
              environmentId: 'local',
              locationId: 'claude-skills',
              targetIds: ['claude'],
              toFormat: 'markdown-frontmatter',
              path: '/path/first',
              outcomes: [],
            },
          ],
        }),
      ],
    };
    const writeResult = [
      applied({ resourceKey: 'skill:second', locationId: 'claude-skills' }),
      applied({ resourceKey: 'skill:first', locationId: 'claude-skills' }),
    ];

    const summaries = summarizeAppliedResources(preview, writeResult);

    // Preview order ("second" then "first"), not applied-array order.
    expect(summaries.map((s) => s.slug)).toEqual(['second', 'first']);
  });

  it('does not count a destination that was not written', () => {
    const preview: PropagationPreview = {
      previewToken: 'token',
      stateHash: 'hash',
      entries: [
        entry({
          destinations: [
            {
              environmentId: 'local',
              locationId: 'claude-skills',
              targetIds: ['claude'],
              toFormat: 'markdown-frontmatter',
              path: '/path/claude',
              outcomes: [],
            },
            {
              environmentId: 'local',
              locationId: 'cursor-skills',
              targetIds: ['cursor'],
              toFormat: 'markdown-frontmatter',
              path: '/path/cursor',
              outcomes: [],
            },
          ],
        }),
      ],
    };
    // Only the claude-skills destination actually wrote.
    const writeResult = [applied({ locationId: 'claude-skills' })];

    const summaries = summarizeAppliedResources(preview, writeResult);

    expect(summaries).toEqual([
      { kind: 'skill', slug: 'gh', targets: ['claude'], environmentId: 'local' },
    ]);
  });
  it('reports no single environment when one resource landed on several machines', () => {
    const preview: PropagationPreview = {
      previewToken: 'token',
      stateHash: 'hash',
      entries: [
        entry({
          destinations: [
            {
              environmentId: 'local',
              locationId: 'claude-skills',
              targetIds: ['claude'],
              toFormat: 'markdown-frontmatter',
              path: '/home/user/.claude/skills/gh/SKILL.md',
              outcomes: [],
            },
            {
              environmentId: 'devbox',
              locationId: 'codex-skills',
              targetIds: ['codex'],
              toFormat: 'markdown-frontmatter',
              path: '/home/user/.codex/skills/gh/SKILL.md',
              outcomes: [],
            },
          ],
        }),
      ],
    };
    const writeResult = [
      applied({ environmentId: 'local', locationId: 'claude-skills' }),
      applied({ environmentId: 'devbox', locationId: 'codex-skills' }),
    ];

    const summaries = summarizeAppliedResources(preview, writeResult);

    // Scoping the row to whichever machine happened to be written first is a
    // filter that quietly lies about where the resource went.
    expect(summaries).toEqual([
      { kind: 'skill', slug: 'gh', targets: ['claude', 'codex'], environmentId: null },
    ]);
  });
});
