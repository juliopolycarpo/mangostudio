/**
 * The removal wizard after the server refuses an apply.
 *
 * A 409 means the preview the draft was built against no longer describes the
 * disk. Pressing Remove again can only reproduce the refusal, so the button has
 * to go out of reach until a fresh preview arrives.
 */

import { en } from '@mangostudio/shared/i18n';
import type { RemovalPreview } from '@mangostudio/shared/library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { RemovalWizard } from '../../../../src/features/library/components/RemovalWizard';
import { screen } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const preview: RemovalPreview = {
  previewToken: 'token',
  stateHash: 'state',
  entries: [
    {
      resourceKey: 'skill:gh',
      ref: { kind: 'skill', slug: 'gh' },
      divergence: 'uniform',
      locations: [
        {
          environmentId: 'local',
          locationId: 'claude-skills',
          targetIds: [],
          operation: 'remove',
          path: '/home/dev/.claude/skills/gh',
          contentHash: 'a3f9c1',
          modifiedAtMs: 1_700_000_000_000,
          eliminatesContentGroup: false,
        },
      ],
      instancePlacements: [
        { environmentId: 'local', locationId: 'claude-skills' },
        { environmentId: 'local', locationId: 'agents-skills' },
      ],
      wouldRemoveLastCopy: false,
    },
  ],
  staleStagedRemovals: [],
};

const scenario = createFetchScenario()
  .respondWithJson('POST', '/api/library/removal/preview', { body: preview })
  .respondWithJson('POST', '/api/library/removal/apply', {
    status: 409,
    body: { error: 'The library changed since this preview was taken.', code: 'VALIDATION' },
  });

afterEach(() => {
  scenario.restore();
});

describe('RemovalWizard after a stale rejection', () => {
  it('puts Remove out of reach until a fresh preview arrives', async () => {
    scenario.install();
    const user = userEvent.setup();

    await renderWithRouter(
      <RemovalWizard
        resourceKeys={['skill:gh']}
        locationIds={['claude-skills']}
        onClose={() => undefined}
      />
    );

    await user.click(await screen.findByTestId('removal-row'));
    await user.click(screen.getByTestId('continue-button'));

    const remove = screen.getByTestId('remove-button');
    expect(remove).toBeEnabled();
    await user.click(remove);

    expect(await screen.findByText(en.library.removal.stale)).toBeInTheDocument();
    // Clicking again would send the same draft against the same refused
    // preview; "Preview again" beside the banner is the only way on.
    expect(screen.getByTestId('remove-button')).toBeDisabled();
  });
});
