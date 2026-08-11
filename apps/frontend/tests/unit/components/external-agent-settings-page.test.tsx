/**
 * The only surface where an acknowledged third-party notice can be read back
 * and withdrawn.
 *
 * A consent nobody can withdraw is not a consent, so the cases that matter are
 * the ones that decide what the user is told about their own record: that an
 * unanswered query is never reported as "you have agreed to nothing", and that
 * withdrawing actually reaches the server.
 */

import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalAgentSettingsPage } from '../../../src/features/settings/external-agents';
import { render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const ACKNOWLEDGED_AT = Date.parse('2026-08-08T09:30:00.000Z');

function respondWithDisclosures(
  fetchScenario: ReturnType<typeof createFetchScenario>,
  disclosures: Array<{ targetId: string; disclosureVersion: number; acknowledgedAt: number }>
) {
  fetchScenario.respondWithJson('GET', '/api/external-agents/disclosures', {
    body: { disclosures },
  });
}

describe('ExternalAgentSettingsPage', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('lists an acknowledged vendor with when it was agreed to', async () => {
    respondWithDisclosures(fetchScenario, [
      { targetId: 'claude', disclosureVersion: 1, acknowledgedAt: ACKNOWLEDGED_AT },
    ]);

    render(<ExternalAgentSettingsPage />);

    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText(/Acknowledged/)).toBeInTheDocument();
  });

  it('says the record is empty only once the answer has arrived', async () => {
    respondWithDisclosures(fetchScenario, []);

    render(<ExternalAgentSettingsPage />);

    // The claim is about this account. Making it while the query is still in
    // flight would tell every user their consents were gone on every page load.
    expect(screen.queryByText(/have not acknowledged any external agent/i)).toBeNull();
    expect(
      await screen.findByText(/have not acknowledged any external agent/i)
    ).toBeInTheDocument();
  });

  it('withdraws the acknowledgement for the vendor whose row was clicked', async () => {
    respondWithDisclosures(fetchScenario, [
      { targetId: 'claude', disclosureVersion: 1, acknowledgedAt: ACKNOWLEDGED_AT },
    ]);
    fetchScenario.respondWithJson('DELETE', '/api/external-agents/claude/disclosure', {
      body: { revoked: true },
    });

    render(<ExternalAgentSettingsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /withdraw/i }));

    // The vendor in the path is the assertion. A revoke that reached
    // `/external-agents/disclosure` — or another target's row — would withdraw a
    // consent the user did not touch, which is exactly what the server-side
    // reap was just narrowed to avoid.
    await vi.waitFor(() => {
      expect(
        fetchScenario.fetchMock.mock.calls.some(
          ([input, init]) =>
            (init?.method ?? 'GET').toUpperCase() === 'DELETE' &&
            String(input).includes('/external-agents/claude/disclosure')
        )
      ).toBe(true);
    });
  });

  /** Withdrawing is the safe direction, so it is never hidden behind a confirm. */
  it('warns that withdrawing stops a running turn', async () => {
    respondWithDisclosures(fetchScenario, []);
    render(<ExternalAgentSettingsPage />);

    expect(await screen.findByText(/stops any turn running now/i)).toBeInTheDocument();
  });
});
