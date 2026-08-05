/**
 * The wizard steps as a user meets them.
 *
 * These cover the four claims the flow rests on: a divergence cannot be walked
 * past, a location serving two agents says so, a destination nobody can write
 * to is disabled with its reason, and an overwrite shows what it replaces.
 */

import { en } from '@mangostudio/shared/i18n';
import { describe, expect, it, vi } from 'vitest';
import { ConflictStep } from '../../../../src/features/library/components/ConflictStep';
import { DestinationStep } from '../../../../src/features/library/components/DestinationStep';
import { ReviewStep } from '../../../../src/features/library/components/ReviewStep';
import {
  destinationKey,
  initialDraft,
  unresolvedEntries,
} from '../../../../src/features/library/propagation';
import { screen, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { destination, location, preview, previewEntry, sourceGroup } from './fixtures';

const divergentPreview = preview([
  previewEntry({
    sourceGroups: [
      sourceGroup({ contentHash: 'a3f9c1', instanceCount: 3 }),
      sourceGroup({
        contentHash: '7c21e8',
        instanceCount: 1,
        locationIds: ['cursor-skills'],
        contentLocationId: 'cursor-skills',
      }),
    ],
  }),
]);

describe('ConflictStep', () => {
  it('offers no default winner and reports the resource as unresolved', async () => {
    const draft = initialDraft(divergentPreview);

    await renderWithRouter(
      <ConflictStep
        preview={divergentPreview}
        draft={draft}
        unresolved={unresolvedEntries(divergentPreview, draft)}
        onResolve={() => undefined}
      />
    );

    // 009 rejects an apply without a named winner, so the step has to keep the
    // user here rather than let them meet that error later.
    expect(screen.getByTestId('unresolved-count')).toHaveTextContent('1');
    expect(screen.getByTestId('conflict-entry')).toHaveAttribute('data-resolved', 'false');
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
  });

  it('marks the resource resolved once a version is chosen', async () => {
    const draft = {
      ...initialDraft(divergentPreview),
      resolutions: {
        'skill:gh': { resolution: 'adopt-group' as const, winnerContentHash: '7c21e8' },
      },
    };

    await renderWithRouter(
      <ConflictStep
        preview={divergentPreview}
        draft={draft}
        unresolved={unresolvedEntries(divergentPreview, draft)}
        onResolve={() => undefined}
      />
    );

    expect(screen.getByTestId('conflict-entry')).toHaveAttribute('data-resolved', 'true');
    expect(screen.queryByTestId('unresolved-count')).not.toBeInTheDocument();
  });

  it('presents keeping the copies different as a real answer', async () => {
    const onResolve = vi.fn();
    const draft = initialDraft(divergentPreview);

    await renderWithRouter(
      <ConflictStep
        preview={divergentPreview}
        draft={draft}
        unresolved={unresolvedEntries(divergentPreview, draft)}
        onResolve={onResolve}
      />
    );

    expect(screen.getByText(en.library.conflict.keepPerLocation.title)).toBeInTheDocument();
    // The explanation is the point: it is a commitment that lasts until one of
    // the contents changes, not a way to dismiss the prompt.
    expect(screen.getByText(en.library.conflict.keepPerLocation.description)).toBeInTheDocument();
  });

  it('does not offer editing a skill, which is a directory', async () => {
    const draft = initialDraft(divergentPreview);

    await renderWithRouter(
      <ConflictStep
        preview={divergentPreview}
        draft={draft}
        unresolved={unresolvedEntries(divergentPreview, draft)}
        onResolve={() => undefined}
      />
    );

    expect(screen.getByTestId('edit-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-then-adopt')).not.toBeInTheDocument();
  });
});

describe('DestinationStep', () => {
  it('flags a location that serves more than one agent', async () => {
    const shared = preview([
      previewEntry({
        destinations: [
          destination({ locationId: 'agents-skills', targetIds: ['mangostudio', 'codex'] }),
        ],
      }),
    ]);

    await renderWithRouter(
      <DestinationStep
        environmentName={(id: string) => id}
        preview={shared}
        draft={initialDraft(shared)}
        locations={[location()]}
        onToggle={() => undefined}
      />
    );

    // One write covers both; without this notice a user also checks the Codex
    // directory and ends up with a second copy to keep in sync.
    const notice = screen.getByTestId('serves-multiple-targets');
    expect(notice).toHaveTextContent(en.library.targets.codex);
    expect(notice).toHaveTextContent('/home/dev/.agents/skills');
  });

  it('disables a read-only destination and says why', async () => {
    const readOnly = preview([
      previewEntry({
        destinations: [
          destination({
            locationId: 'cursor-skills-builtin',
            targetIds: ['cursor'],
            blockedReason: 'read-only-location',
            outcomes: [],
          }),
        ],
      }),
    ]);

    await renderWithRouter(
      <DestinationStep
        environmentName={(id: string) => id}
        preview={readOnly}
        draft={initialDraft(readOnly)}
        locations={[
          location({ id: 'cursor-skills-builtin', access: 'read-only', targetIds: ['cursor'] }),
        ]}
        onToggle={() => undefined}
      />
    );

    const row = screen.getByTestId('destination-row');
    expect(within(row).getByRole('checkbox')).toBeDisabled();
    expect(within(row).getByTestId('blocked-reason')).toHaveTextContent(
      en.library.blockedReason['read-only-location']
    );
  });

  it('sends an unwritable destination to the surface that reported the problem', async () => {
    const unwritable = preview([
      previewEntry({
        destinations: [
          destination({
            locationId: 'claude-skills',
            blockedReason: 'location-unwritable',
            outcomes: [],
          }),
        ],
      }),
    ]);

    await renderWithRouter(
      <DestinationStep
        environmentName={(id: string) => id}
        preview={unwritable}
        draft={initialDraft(unwritable)}
        locations={[location({ id: 'claude-skills', writable: false })]}
        onToggle={() => undefined}
      />
    );

    expect(
      screen.getByRole('link', { name: en.library.destination.unwritableAction })
    ).toHaveAttribute('href', expect.stringContaining('/environments/agents'));
  });

  it('asks for at least one destination before continuing', async () => {
    const single = preview();

    await renderWithRouter(
      <DestinationStep
        environmentName={(id: string) => id}
        preview={single}
        draft={initialDraft(single)}
        locations={[location()]}
        onToggle={() => undefined}
      />
    );

    expect(screen.getByTestId('no-destination-selected')).toBeInTheDocument();
  });
});

describe('ReviewStep', () => {
  function renderReview(previewValue: ReturnType<typeof preview>, ...checked: string[]) {
    const draft = {
      ...initialDraft(previewValue),
      destinations: new Set(checked.map((locationId) => destinationKey('local', locationId))),
    };
    return renderWithRouter(
      <ReviewStep
        preview={previewValue}
        draft={draft}
        onSelectStrategy={() => undefined}
        onToggleAcknowledged={() => undefined}
      />
    );
  }

  it('shows a diff for an overwrite', async () => {
    const overwriting = preview([
      previewEntry({
        destinations: [
          destination({
            locationId: 'claude-skills',
            currentContentHash: 'old',
            outcomes: [{ winnerContentHash: 'a3f9c1', operation: 'overwrite' }],
          }),
        ],
      }),
    ]);

    await renderReview(overwriting, 'claude-skills');

    // Overwrite is the destructive operation; it never lands unseen.
    expect(screen.getByTestId('overwrite-diff')).toBeInTheDocument();
  });

  it('keeps already-synced destinations visible, collapsed', async () => {
    const synced = preview([
      previewEntry({
        destinations: [
          destination({
            locationId: 'agents-skills',
            currentContentHash: 'a3f9c1',
            outcomes: [{ winnerContentHash: 'a3f9c1', operation: 'noop' }],
          }),
        ],
      }),
    ]);

    await renderReview(synced, 'agents-skills');

    const noop = screen.getByTestId('review-noop');
    expect(noop).toBeInTheDocument();
    // "Already in sync" is a result the user asked for, not an absence.
    expect(noop).not.toHaveAttribute('open');
    expect(noop).toHaveTextContent(en.library.review.groupNoop);
  });

  it('demands a sign-off before a model-drafted conversion can be written', async () => {
    const drafted = preview([
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

    await renderReview(drafted, 'cursor-skills');

    expect(screen.getByTestId('adaptation-acknowledge')).not.toBeChecked();
    expect(screen.getByText(en.library.adaptation.strategy.agent)).toBeInTheDocument();
  });

  it('summarizes how many files are written and backed up', async () => {
    const mixed = preview([
      previewEntry({
        destinations: [
          destination({
            locationId: 'claude-skills',
            currentContentHash: 'old',
            outcomes: [{ winnerContentHash: 'a3f9c1', operation: 'overwrite' }],
          }),
          destination({
            locationId: 'codex-skills',
            targetIds: ['codex'],
            outcomes: [{ winnerContentHash: 'a3f9c1', operation: 'create' }],
          }),
        ],
      }),
    ]);

    await renderReview(mixed, 'claude-skills', 'codex-skills');

    expect(screen.getByTestId('review-summary')).toHaveTextContent('2');
  });
});
