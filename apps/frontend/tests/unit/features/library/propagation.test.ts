/**
 * The wizard's decision logic against the apply contract.
 *
 * Every assertion here mirrors a rule 009 enforces server-side. The point is
 * that the client refuses the same things for the same reasons, so a user is
 * never walked into a 422 the form could have prevented.
 */

import { describe, expect, it } from 'vitest';
import {
  applySummary,
  buildDecisions,
  effectiveStrategy,
  initialDraft,
  isNoopApply,
  operationKey,
  plannedWrite,
  plannedWrites,
  unresolvedEntries,
  type WizardDraft,
  winnerGroup,
} from '../../../../src/features/library/propagation';
import { destination, preview, previewEntry, sourceGroup } from './fixtures';

function withDestinations(draft: WizardDraft, ...locationIds: string[]): WizardDraft {
  return { ...draft, destinations: new Set(locationIds) };
}

describe('initialDraft', () => {
  it('pre-resolves a resource with one readable version', () => {
    const single = preview();

    const draft = initialDraft(single);

    expect(draft.resolutions['skill:gh']).toEqual({
      resolution: 'adopt-group',
      winnerContentHash: 'a3f9c1',
    });
    expect(unresolvedEntries(single, draft)).toEqual([]);
  });

  it('leaves a divergent resource undecided', () => {
    const divergent = preview([
      previewEntry({
        sourceGroups: [
          sourceGroup({ contentHash: 'a3f9c1' }),
          sourceGroup({ contentHash: '7c21e8' }),
        ],
      }),
    ]);

    const draft = initialDraft(divergent);

    expect(draft.resolutions['skill:gh'].resolution).toBeNull();
    // 009 has no tiebreaker, so neither does the form — no default selection.
    expect(unresolvedEntries(divergent, draft)).toHaveLength(1);
  });

  it('checks no destination, so the safe path is the default one', () => {
    expect(initialDraft(preview()).destinations.size).toBe(0);
  });
});

describe('unresolvedEntries', () => {
  const divergent = preview([
    previewEntry({
      sourceGroups: [
        sourceGroup({ contentHash: 'a3f9c1' }),
        sourceGroup({ contentHash: '7c21e8' }),
      ],
    }),
  ]);

  it('blocks continuing until a divergent resource is settled', () => {
    expect(unresolvedEntries(divergent, initialDraft(divergent))).toHaveLength(1);
  });

  it('accepts a named winner', () => {
    const draft = {
      ...initialDraft(divergent),
      resolutions: {
        'skill:gh': { resolution: 'adopt-group' as const, winnerContentHash: '7c21e8' },
      },
    };

    expect(unresolvedEntries(divergent, draft)).toEqual([]);
    expect(winnerGroup(divergent.entries[0], draft)?.contentHash).toBe('7c21e8');
  });

  it('rejects a winner hash the preview no longer offers', () => {
    // A re-preview can retire a version; the stale pick must not sail through.
    const draft = {
      ...initialDraft(divergent),
      resolutions: {
        'skill:gh': { resolution: 'adopt-group' as const, winnerContentHash: 'gone' },
      },
    };

    expect(unresolvedEntries(divergent, draft)).toHaveLength(1);
  });

  it('accepts keeping the copies different as a complete answer', () => {
    const draft = {
      ...initialDraft(divergent),
      resolutions: { 'skill:gh': { resolution: 'keep-per-location' as const } },
    };

    expect(unresolvedEntries(divergent, draft)).toEqual([]);
  });

  it('does not accept an empty edit', () => {
    const draft = {
      ...initialDraft(divergent),
      resolutions: {
        'skill:gh': { resolution: 'edit-then-adopt' as const, editedContent: '   ' },
      },
    };

    expect(unresolvedEntries(divergent, draft)).toHaveLength(1);
  });
});

describe('buildDecisions', () => {
  it('names every offered destination, applied or skipped', () => {
    const twoDestinations = preview([
      previewEntry({
        destinations: [
          destination({ locationId: 'agents-skills' }),
          destination({ locationId: 'claude-skills', targetIds: ['claude'] }),
        ],
      }),
    ]);
    const draft = withDestinations(initialDraft(twoDestinations), 'agents-skills');

    const [decision] = buildDecisions(twoDestinations, draft);

    // A dropped destination would leave the response silent about a location
    // the user was shown, so the apply route rejects an incomplete list.
    expect(decision.destinations).toEqual([
      { locationId: 'agents-skills', action: 'apply' },
      { locationId: 'claude-skills', action: 'skip' },
    ]);
  });

  it('skips a blocked destination even when it is checked', () => {
    const blocked = preview([
      previewEntry({
        destinations: [
          destination({
            locationId: 'cursor-skills-builtin',
            blockedReason: 'read-only-location',
            outcomes: [],
          }),
        ],
      }),
    ]);
    const draft = withDestinations(initialDraft(blocked), 'cursor-skills-builtin');

    const [decision] = buildDecisions(blocked, draft);

    expect(decision.destinations).toEqual([
      { locationId: 'cursor-skills-builtin', action: 'skip' },
    ]);
  });

  it('never writes anywhere when the divergence is kept', () => {
    const divergent = preview([
      previewEntry({
        sourceGroups: [sourceGroup({ contentHash: 'a' }), sourceGroup({ contentHash: 'b' })],
        destinations: [destination({ locationId: 'agents-skills' })],
      }),
    ]);
    const draft = {
      ...withDestinations(initialDraft(divergent), 'agents-skills'),
      resolutions: { 'skill:gh': { resolution: 'keep-per-location' as const } },
    };

    const [decision] = buildDecisions(divergent, draft);

    expect(decision.resolution).toBe('keep-per-location');
    // Keeping the divergence and writing to a destination is contradictory, and
    // the apply route refuses the pair outright.
    expect(decision.destinations.every((target) => target.action === 'skip')).toBe(true);
    expect(decision.winnerContentHash).toBeUndefined();
  });

  it('sends the chosen adapter strategy with an adapting write', () => {
    const adapting = preview([
      previewEntry({
        destinations: [
          destination({
            locationId: 'cursor-skills',
            targetIds: ['cursor'],
            toFormat: 'mdc',
            outcomes: [
              {
                winnerContentHash: 'a3f9c1',
                operation: 'adapt-create',
                adaptation: {
                  fromFormat: 'markdown-frontmatter',
                  toFormat: 'mdc',
                  availableStrategies: ['mechanical', 'agent'],
                  recommendedStrategy: 'mechanical',
                },
              },
            ],
          }),
        ],
      }),
    ]);
    const draft = withDestinations(initialDraft(adapting), 'cursor-skills');

    const [decision] = buildDecisions(adapting, draft);

    // An adaptation without an explicit strategy is rejected server-side, so the
    // preview's recommendation is what goes out when the user leaves it alone.
    expect(decision.destinations[0]).toEqual({
      locationId: 'cursor-skills',
      action: 'apply',
      strategy: 'mechanical',
    });
  });

  it('carries edited content instead of a winner hash', () => {
    const editable = preview([
      previewEntry({
        ref: { kind: 'instruction', slug: 'global' },
        sourceGroups: [sourceGroup({ contentHash: 'a' }), sourceGroup({ contentHash: 'b' })],
        destinations: [destination({ locationId: 'claude-instructions' })],
      }),
    ]);
    const draft = {
      ...withDestinations(initialDraft(editable), 'claude-instructions'),
      resolutions: {
        'skill:gh': { resolution: 'edit-then-adopt' as const, editedContent: '# merged' },
      },
    };

    const [decision] = buildDecisions(editable, draft);

    expect(decision.resolution).toBe('edit-then-adopt');
    expect(decision.editedContent).toBe('# merged');
    expect(decision.winnerContentHash).toBeUndefined();
  });
});

describe('plannedWrites', () => {
  const overwriting = preview([
    previewEntry({
      destinations: [
        destination({
          locationId: 'claude-skills',
          targetIds: ['claude'],
          currentContentHash: 'old',
          outcomes: [{ winnerContentHash: 'a3f9c1', operation: 'overwrite' }],
        }),
        destination({
          locationId: 'agents-skills',
          currentContentHash: 'a3f9c1',
          outcomes: [{ winnerContentHash: 'a3f9c1', operation: 'noop' }],
        }),
      ],
    }),
  ]);

  it('summarizes writes and backups separately', () => {
    const draft = withDestinations(initialDraft(overwriting), 'claude-skills', 'agents-skills');

    const summary = applySummary(plannedWrites(overwriting, draft));

    expect(summary).toEqual({ writes: 1, backups: 1, blocked: 0, noop: 1 });
  });

  it('reports an already-synced destination as a noop rather than dropping it', () => {
    const draft = withDestinations(initialDraft(overwriting), 'agents-skills');

    const writes = plannedWrites(overwriting, draft);

    expect(writes).toHaveLength(1);
    expect(writes[0].operation).toBe('noop');
    // "Already in sync" is a result the user asked for, so applying is not a
    // no-op overall — but with only noops there is nothing to write.
    expect(isNoopApply(overwriting, draft)).toBe(true);
  });

  it('counts an unchecked destination as no planned write at all', () => {
    expect(plannedWrites(overwriting, initialDraft(overwriting))).toEqual([]);
  });
});

describe('model-drafted conversions', () => {
  const agentAdaptation = preview([
    previewEntry({
      destinations: [
        destination({
          locationId: 'cursor-skills',
          targetIds: ['cursor'],
          toFormat: 'mdc',
          outcomes: [
            {
              winnerContentHash: 'a3f9c1',
              operation: 'adapt-create',
              adaptation: {
                fromFormat: 'markdown-frontmatter',
                toFormat: 'mdc',
                availableStrategies: ['agent'],
                recommendedStrategy: 'agent',
              },
            },
          ],
        }),
      ],
    }),
  ]);

  it('defaults to the recommended strategy', () => {
    const draft = withDestinations(initialDraft(agentAdaptation), 'cursor-skills');
    const write = plannedWrite(
      agentAdaptation.entries[0],
      agentAdaptation.entries[0].destinations[0],
      draft
    );

    expect(effectiveStrategy(write, draft)).toBe('agent');
  });

  it('reports the write as awaiting a sign-off until one is given', async () => {
    const { pendingAcknowledgements } = await import(
      '../../../../src/features/library/propagation'
    );
    const draft = withDestinations(initialDraft(agentAdaptation), 'cursor-skills');

    // `requiresReview` is always true for the agent strategy, so the draft can
    // never be applied on the strength of the preview alone.
    expect(pendingAcknowledgements(agentAdaptation, draft)).toHaveLength(1);

    const acknowledged: WizardDraft = {
      ...draft,
      acknowledged: new Set([operationKey('skill:gh', 'cursor-skills')]),
    };
    expect(pendingAcknowledgements(agentAdaptation, acknowledged)).toEqual([]);
  });

  it('does not demand a sign-off for a mechanical conversion', async () => {
    const { pendingAcknowledgements } = await import(
      '../../../../src/features/library/propagation'
    );
    const mechanical = preview([
      previewEntry({
        destinations: [
          destination({
            locationId: 'cursor-skills',
            toFormat: 'mdc',
            outcomes: [
              {
                winnerContentHash: 'a3f9c1',
                operation: 'adapt-create',
                adaptation: {
                  fromFormat: 'markdown-frontmatter',
                  toFormat: 'mdc',
                  availableStrategies: ['mechanical'],
                  recommendedStrategy: 'mechanical',
                },
              },
            ],
          }),
        ],
      }),
    ]);
    const draft = withDestinations(initialDraft(mechanical), 'cursor-skills');

    expect(pendingAcknowledgements(mechanical, draft)).toEqual([]);
  });
});
