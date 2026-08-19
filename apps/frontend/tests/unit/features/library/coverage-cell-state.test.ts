/**
 * The glyph rules, table-driven over every coverage/divergence combination.
 *
 * The two that matter most are the ones 008 keeps orthogonal: identical copies
 * in two of a target's locations are shadowed, different copies are divergent,
 * and a UI that renders both as one warning has thrown away the distinction the
 * scanner worked to produce.
 */

import { describe, expect, it } from 'vitest';
import {
  type CoverageCellState,
  coverageCell,
  coverageCells,
  majorityContentHash,
  presentTargetCount,
  summarizeCoverageByTarget,
} from '../../../../src/features/library/format';
import { fullCoverage, instance, resource } from './fixtures';

describe('coverageCell', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly build: () => ReturnType<typeof resource>;
    readonly targetIndex: number;
    readonly expected: CoverageCellState;
  }> = [
    {
      name: 'no copy anywhere the target reads',
      build: () => resource(),
      targetIndex: 1,
      expected: 'absent',
    },
    {
      name: 'one copy, one of several targets present',
      build: () =>
        resource({
          instances: [
            instance({ locationId: 'agents-skills' }),
            instance({ locationId: 'claude-skills' }),
          ],
          coverage: fullCoverage({
            mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
            claude: { state: 'present', effectiveLocationId: 'claude-skills' },
          }),
          divergence: 'uniform',
        }),
      targetIndex: 0,
      expected: 'present',
    },
    {
      name: 'the only target holding the resource',
      build: () =>
        resource({
          instances: [instance({ locationId: 'cursor-skills' })],
          coverage: fullCoverage({
            cursor: { state: 'present', effectiveLocationId: 'cursor-skills' },
          }),
        }),
      targetIndex: 3,
      expected: 'only-here',
    },
    {
      name: 'two locations for one target holding identical bytes',
      build: () =>
        resource({
          instances: [
            instance({ locationId: 'codex-skills' }),
            instance({ locationId: 'agents-skills' }),
            instance({ locationId: 'claude-skills' }),
          ],
          coverage: fullCoverage({
            mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
            claude: { state: 'present', effectiveLocationId: 'claude-skills' },
            codex: {
              state: 'shadowed',
              effectiveLocationId: 'codex-skills',
              shadowedLocationIds: ['agents-skills'],
            },
          }),
          divergence: 'uniform',
        }),
      targetIndex: 2,
      expected: 'shadowed',
    },
    {
      name: 'a minority version, as the divergent one',
      build: () =>
        resource({
          instances: [
            instance({ locationId: 'agents-skills', contentHash: 'a3f9c1' }),
            instance({ locationId: 'claude-skills', contentHash: 'a3f9c1' }),
            instance({ locationId: 'codex-skills', contentHash: 'a3f9c1' }),
            instance({ locationId: 'cursor-skills', contentHash: '7c21e8' }),
          ],
          coverage: fullCoverage({
            mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
            claude: { state: 'present', effectiveLocationId: 'claude-skills' },
            codex: { state: 'present', effectiveLocationId: 'codex-skills' },
            cursor: { state: 'present', effectiveLocationId: 'cursor-skills' },
          }),
          divergence: 'divergent',
        }),
      targetIndex: 3,
      expected: 'divergent',
    },
    {
      name: 'the majority version, as settled',
      build: () =>
        resource({
          instances: [
            instance({ locationId: 'agents-skills', contentHash: 'a3f9c1' }),
            instance({ locationId: 'claude-skills', contentHash: 'a3f9c1' }),
            instance({ locationId: 'cursor-skills', contentHash: '7c21e8' }),
          ],
          coverage: fullCoverage({
            mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
            claude: { state: 'present', effectiveLocationId: 'claude-skills' },
            cursor: { state: 'present', effectiveLocationId: 'cursor-skills' },
          }),
          divergence: 'divergent',
        }),
      targetIndex: 1,
      expected: 'present',
    },
    {
      name: 'mixed directory-hash domains, which must not look like divergence',
      build: () =>
        resource({
          instances: [
            instance({ locationId: 'agents-skills', contentHash: 'v2-hash' }),
            instance({ locationId: 'claude-skills', contentHash: 'v1-hash' }),
          ],
          coverage: fullCoverage({
            mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
            claude: { state: 'present', effectiveLocationId: 'claude-skills' },
          }),
          divergence: 'incomparable',
        }),
      targetIndex: 0,
      expected: 'incomparable',
    },
    {
      name: 'an unreadable copy, which cannot be judged divergent',
      build: () =>
        resource({
          instances: [
            instance({ locationId: 'agents-skills' }),
            instance({
              locationId: 'claude-skills',
              valid: false,
              invalidReason: 'unreadable',
              contentHash: undefined,
              sizeBytes: undefined,
            }),
          ],
          coverage: fullCoverage({
            mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
            claude: { state: 'present', effectiveLocationId: 'claude-skills' },
          }),
        }),
      targetIndex: 1,
      expected: 'present',
    },
  ];

  for (const testCase of cases) {
    it(`renders ${testCase.expected} for ${testCase.name}`, () => {
      const built = testCase.build();
      const cell = coverageCell(built, built.coverage[testCase.targetIndex]);
      expect(cell.state).toBe(testCase.expected);
    });
  }

  it('keeps a shadow with identical hashes distinct from a divergence', () => {
    const identicalShadow = resource({
      instances: [
        instance({ locationId: 'codex-skills', contentHash: 'same' }),
        instance({ locationId: 'agents-skills', contentHash: 'same' }),
      ],
      coverage: fullCoverage({
        mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
        codex: {
          state: 'shadowed',
          effectiveLocationId: 'codex-skills',
          shadowedLocationIds: ['agents-skills'],
        },
      }),
      divergence: 'uniform',
    });
    const differingShadow = resource({
      instances: [
        instance({ locationId: 'codex-skills', contentHash: 'left' }),
        instance({ locationId: 'agents-skills', contentHash: 'right' }),
      ],
      coverage: fullCoverage({
        mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
        codex: {
          state: 'shadowed',
          effectiveLocationId: 'codex-skills',
          shadowedLocationIds: ['agents-skills'],
        },
      }),
      divergence: 'divergent',
    });

    expect(coverageCell(identicalShadow, identicalShadow.coverage[2]).state).toBe('shadowed');
    // Two of Codex's own locations disagreeing is the actionable case, and a
    // precedence rule silently deciding which one wins is what makes it one.
    expect(coverageCell(differingShadow, differingShadow.coverage[2]).state).toBe('divergent');
  });

  it('treats a resource only in agents-skills as present for MangoStudio and Codex', () => {
    // The API resolves coverage from each target's read precedence; the matrix
    // must render both columns as present from that single instance.
    const shared = resource({
      instances: [instance({ locationId: 'agents-skills' })],
      coverage: fullCoverage({
        mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
        codex: { state: 'present', effectiveLocationId: 'agents-skills' },
      }),
    });

    const cells = coverageCells(shared);

    expect(cells.map((cell) => cell.state)).toEqual(['present', 'absent', 'present', 'absent']);
    expect(presentTargetCount(shared)).toBe(2);
  });

  it('carries the facts a tooltip needs on every present cell', () => {
    const withFacts = resource({
      instances: [
        instance({
          locationId: 'agents-skills',
          path: '/home/dev/.agents/skills/gh',
          contentHash: 'a3f9c1deadbeef',
          modifiedAtMs: 42,
        }),
      ],
      coverage: fullCoverage({
        mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
      }),
    });

    const cell = coverageCell(withFacts, withFacts.coverage[0]);

    expect(cell.path).toBe('/home/dev/.agents/skills/gh');
    expect(cell.contentHash).toBe('a3f9c1deadbeef');
    expect(cell.modifiedAtMs).toBe(42);
  });
});

describe('majorityContentHash', () => {
  it('has no majority when the two largest groups are tied', () => {
    // Two against two: neither side is the norm, so neither may be presented as
    // the version the others should agree with.
    expect(
      majorityContentHash([
        { contentHash: 'left', instanceCount: 2, locationIds: [] },
        { contentHash: 'right', instanceCount: 2, locationIds: [] },
      ])
    ).toBeNull();
  });

  it('names the most-replicated hash when one clearly leads', () => {
    expect(
      majorityContentHash([
        { contentHash: 'left', instanceCount: 3, locationIds: [] },
        { contentHash: 'right', instanceCount: 1, locationIds: [] },
      ])
    ).toBe('left');
  });

  it('has no majority for a resource that never diverged', () => {
    expect(
      majorityContentHash([{ contentHash: 'only', instanceCount: 4, locationIds: [] }])
    ).toBeNull();
  });
});

describe('a tie between versions', () => {
  it('marks every present cell divergent rather than crowning one', () => {
    const tied = resource({
      instances: [
        instance({ locationId: 'agents-skills', contentHash: 'left' }),
        instance({ locationId: 'claude-skills', contentHash: 'right' }),
      ],
      coverage: fullCoverage({
        mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
        claude: { state: 'present', effectiveLocationId: 'claude-skills' },
      }),
      divergence: 'divergent',
    });

    const cells = coverageCells(tied);

    expect(cells[0].state).toBe('divergent');
    expect(cells[1].state).toBe('divergent');
  });
});

describe('summarizeCoverageByTarget', () => {
  const divergentSkill = resource({
    instances: [
      instance({ locationId: 'agents-skills', contentHash: 'aaa' }),
      instance({ locationId: 'claude-skills', contentHash: 'aaa' }),
      instance({ locationId: 'cursor-skills', contentHash: 'bbb' }),
    ],
    coverage: fullCoverage({
      mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
      claude: { state: 'present', effectiveLocationId: 'claude-skills' },
      cursor: { state: 'present', effectiveLocationId: 'cursor-skills' },
    }),
    divergence: 'divergent',
  });

  it('counts divergent copies inside the present total, not beside it', () => {
    const summaries = summarizeCoverageByTarget(
      [divergentSkill],
      ['mangostudio', 'claude', 'codex', 'cursor']
    );

    expect(summaries).toEqual([
      { targetId: 'mangostudio', present: 1, divergent: 0 },
      { targetId: 'claude', present: 1, divergent: 0 },
      // Reads nothing: absent is a normal answer, not a gap to fill.
      { targetId: 'codex', present: 0, divergent: 0 },
      // The odd copy out, which is the number worth opening the matrix for.
      { targetId: 'cursor', present: 1, divergent: 1 },
    ]);
  });

  it('keeps a line for a target no resource reaches', () => {
    const summaries = summarizeCoverageByTarget([], ['mangostudio', 'claude']);

    expect(summaries.map((summary) => summary.targetId)).toEqual(['mangostudio', 'claude']);
    expect(summaries.every((summary) => summary.present === 0)).toBe(true);
  });
});
