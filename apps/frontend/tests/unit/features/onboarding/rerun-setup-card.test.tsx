/**
 * Re-running setup is a write before it is a navigation.
 *
 * The failure that matters is the quiet one: a clear the server refused, after
 * which the card used to navigate anyway and the wizard would open on a run the
 * account still has recorded as finished.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const navigate = jest.fn();

mock.module('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}));

const { RerunSetupCard } = await import('@/features/onboarding/RerunSetupCard');

const scenario = createFetchScenario();

beforeEach(() => {
  navigate.mockClear();
  scenario.respondWithJson('GET', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });
});

afterEach(() => {
  scenario.restore();
});

describe('RerunSetupCard', () => {
  it('opens setup once the record is cleared', async () => {
    scenario.respondWithJson('PUT', '/api/settings/app', { body: DEFAULT_APP_SETTINGS });
    scenario.install();
    const user = userEvent.setup();

    render(<RerunSetupCard />);
    await user.click(screen.getByTestId('rerun-setup'));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/welcome' }));
  });

  it('stays put and says so when the clear is refused', async () => {
    scenario.respondWithJson('PUT', '/api/settings/app', {
      status: 500,
      body: { error: 'nope', code: 'INTERNAL' },
    });
    scenario.install();
    const user = userEvent.setup();

    render(<RerunSetupCard />);
    await user.click(screen.getByTestId('rerun-setup'));

    await waitFor(() => expect(screen.getByTestId('rerun-setup-failed')).toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
  });
});
