/**
 * The wizard opened with nothing to propagate to.
 *
 * Both openers offer the action unconditionally, so this is the surface that
 * has to tell "no enabled destination" apart from "the preview failed" — the
 * second is a lie, and the Retry it offers cannot fix the first.
 */

import { en } from '@mangostudio/shared/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { PropagationWizard } from '../../../../src/features/library/components/PropagationWizard';
import { screen } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario().respondWithJson('GET', '/api/library/locations', {
  body: [],
});

afterEach(() => {
  scenario.restore();
});

describe('PropagationWizard without candidate destinations', () => {
  it('explains the empty destination list instead of reporting a failed preview', async () => {
    scenario.install();

    await renderWithRouter(
      <PropagationWizard resourceKeys={['skill:gh']} locationIds={[]} onClose={() => undefined} />
    );

    expect(screen.getByTestId('library-empty')).toHaveTextContent(en.library.wizard.noDestinations);
    expect(screen.queryByTestId('library-error')).not.toBeInTheDocument();
    // Continuing would walk into steps built from a preview that was never asked for.
    expect(screen.getByTestId('continue-button')).toBeDisabled();
  });

  it('never asks the API to preview an empty target list', async () => {
    scenario.install();

    await renderWithRouter(
      <PropagationWizard resourceKeys={['skill:gh']} locationIds={[]} onClose={() => undefined} />
    );

    // The contract requires at least one target, so the request the guard
    // prevents would come back 422.
    const previewCalls = scenario.fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/library/propagate/preview')
    );
    expect(previewCalls).toEqual([]);
  });
});
