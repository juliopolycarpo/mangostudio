/**
 * The wizard opened with nothing to propagate to.
 *
 * Both openers offer the action unconditionally, so this is the surface that
 * has to tell "no enabled destination" apart from "the preview failed" — the
 * second is a lie, and the Retry it offers cannot fix the first.
 *
 * And the steps it walks: the conflict step is a step only when a resource has
 * more than one readable version, because a step that says "nothing to choose"
 * is a screen to click through for nothing.
 */

import { afterEach, describe, expect, it, jest } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';

import { PropagationWizard } from '../../../../src/features/library/components/PropagationWizard';
import { screen, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { location, preview, previewEntry, sourceGroup } from './fixtures';

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

    // `find*`, not `get*`: the locations query resolves after the router's own
    // load settles, and asserting synchronously leaves that state update outside
    // `act` — which prints an "update was not wrapped in act(...)" block while
    // the test still passes.
    expect(await screen.findByTestId('library-empty')).toHaveTextContent(
      en.library.wizard.noDestinations
    );
    expect(screen.queryByTestId('library-error')).not.toBeInTheDocument();
    // Continuing would walk into steps built from a preview that was never asked for.
    expect(screen.getByTestId('continue-button')).toBeDisabled();
  });

  it('never asks the API to preview an empty target list', async () => {
    scenario.install();

    await renderWithRouter(
      <PropagationWizard resourceKeys={['skill:gh']} locationIds={[]} onClose={() => undefined} />
    );

    // Settle the locations query first, for the same reason as above — and so
    // the assertion below covers every request the component made, not just the
    // ones issued before the first paint.
    await screen.findByTestId('library-empty');

    // The contract requires at least one target, so the request the guard
    // prevents would come back 422.
    const previewCalls = scenario.fetchMock.mock.calls.filter(([input]) =>
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- The mock records the request target using JavaScript string conversion.
      String(input).includes('/library/propagate/preview')
    );
    expect(previewCalls).toEqual([]);
  });
});

const divergent = preview([
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

function scenarioFor(answer: ReturnType<typeof preview>) {
  return createFetchScenario()
    .respondWithJson('GET', '/api/environments', { body: [] })
    .respondWithJson('GET', '/api/library/locations', { body: [location()] })
    .respondWithJson('POST', '/api/library/propagate/preview', { body: answer });
}

describe('PropagationWizard steps', () => {
  it('opens on the destinations when every resource has one readable version', async () => {
    const own = scenarioFor(preview());
    own.install();
    const onClose = jest.fn();

    await renderWithRouter(
      <PropagationWizard
        resourceKeys={['skill:gh']}
        locationIds={['agents-skills']}
        onClose={onClose}
      />
    );

    expect(await screen.findByTestId('destination-step')).toBeInTheDocument();
    expect(screen.queryByTestId('conflict-step')).not.toBeInTheDocument();
    // Destinations, review, result: no segment for a step that is not coming.
    const steps = within(screen.getByRole('list', { name: /Propagate skill gh/ })).getAllByRole(
      'listitem'
    );
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent(en.library.wizard.stepDestinations);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');

    // Named by its kind and its name, never the internal `kind:name` id.
    expect(screen.getByRole('dialog', { name: 'Propagate skill gh' })).toBeInTheDocument();

    // The first step has no Back to go to, so the footer closes the flow the way
    // every other dialog does: Cancel, then the primary.
    expect(screen.queryByRole('button', { name: en.library.wizard.back })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: en.library.wizard.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);

    own.restore();
  });

  it('keeps the conflict step as the first one when a resource diverges', async () => {
    const own = scenarioFor(divergent);
    own.install();

    await renderWithRouter(
      <PropagationWizard
        resourceKeys={['skill:gh']}
        locationIds={['agents-skills']}
        onClose={() => undefined}
      />
    );

    expect(await screen.findByTestId('conflict-step')).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: /Propagate skill gh/ })).getAllByRole(
      'listitem'
    );
    expect(steps).toHaveLength(4);
    expect(steps[0]).toHaveTextContent(en.library.wizard.stepConflict);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('continue-button')).toBeDisabled();

    own.restore();
  });
});
