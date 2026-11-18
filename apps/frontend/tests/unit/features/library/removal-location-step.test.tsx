/**
 * Step 1 of the removal wizard shows a blocked location with its reason.
 *
 * A location the user switched off is previewed as blocked instead of failing
 * the whole request, so the row has to explain itself and stay out of reach.
 */

import { describe, expect, it } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import type { RemovalBlockedReason, RemovalPreview } from '@mangostudio/shared/library';

import { RemovalLocationStep } from '../../../../src/features/library/components/RemovalLocationStep';
import { initialRemovalDraft } from '../../../../src/features/library/removal';
import { screen, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';

function removalPreview(blockedReason: RemovalBlockedReason): RemovalPreview {
  return {
    previewToken: 'token',
    stateHash: 'state',
    entries: [
      {
        resourceKey: 'skill:gh',
        ref: { kind: 'skill', slug: 'gh' },
        divergence: 'single',
        locations: [
          {
            environmentId: 'local',
            locationId: 'claude-skills',
            targetIds: [],
            operation: 'blocked',
            blockedReason,
            path: null,
            eliminatesContentGroup: false,
          },
          {
            environmentId: 'local',
            locationId: 'mango-skills',
            targetIds: [],
            operation: 'remove',
            path: '/home/dev/.mango/skills/gh',
            contentHash: 'a3f9c1',
            modifiedAtMs: 1_700_000_000_000,
            eliminatesContentGroup: false,
          },
        ],
        instancePlacements: [{ environmentId: 'local', locationId: 'mango-skills' }],
        wouldRemoveLastCopy: true,
      },
    ],
    staleStagedRemovals: [],
  };
}

describe('RemovalLocationStep', () => {
  it.each(['location-disabled', 'location-scan-failed'] as const)(
    'disables a location blocked by %s and says why, leaving the other row removable',
    async (blockedReason) => {
      await renderWithRouter(
        <RemovalLocationStep
          preview={removalPreview(blockedReason)}
          draft={initialRemovalDraft()}
          environmentName={(id: string) => id}
          onToggle={() => undefined}
        />
      );

      const rows = screen.getAllByTestId('removal-row');
      const blocked = rows.find((row) => row.dataset.locationId === 'claude-skills');
      const removable = rows.find((row) => row.dataset.locationId === 'mango-skills');
      if (!blocked || !removable) {
        throw new Error(
          `expected one row per location | received: ${rows.map((row) => row.dataset.locationId).join(', ')}`
        );
      }

      expect(within(blocked).getByRole('checkbox')).toBeDisabled();
      expect(within(blocked).getByTestId('blocked-reason')).toHaveTextContent(
        en.library.blockedReason[blockedReason]
      );
      expect(within(removable).getByRole('checkbox')).toBeEnabled();
    }
  );
});
