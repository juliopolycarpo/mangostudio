/**
 * The only surface where an acknowledged third-party notice can be read back
 * and withdrawn.
 *
 * A consent nobody can withdraw is not a consent, so the cases that matter are
 * the ones that decide what the user is told about their own record: that an
 * unanswered query is never reported as "you have agreed to nothing", and that
 * withdrawing actually reaches the server.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import userEvent from '@testing-library/user-event';

import { ExternalAgentSettingsPage } from '../../../src/features/settings/external-agents';
import { render, screen, waitFor } from '../../support/harness/render';
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

interface TrustGrantFixture {
  targetId: string;
  environmentId: string;
  workspacePath: string;
  version: number;
  acceptedAt: number;
}

function respondWithTrustGrants(
  fetchScenario: ReturnType<typeof createFetchScenario>,
  grants: TrustGrantFixture[]
) {
  fetchScenario.respondWithJson('GET', '/api/external-agents/workspace-trust', {
    body: { grants },
  });
}

describe('ExternalAgentSettingsPage', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
    // Most cases are about the notices; the trust list is simply empty for them.
    respondWithTrustGrants(fetchScenario, []);
    fetchScenario.respondWithJson('GET', '/api/environments', { body: [] });
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
    expect(screen.queryByText(/No external agents acknowledged yet/i)).toBeNull();
    expect(await screen.findByText(/No external agents acknowledged yet/i)).toBeInTheDocument();
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
    await waitFor(() => {
      expect(
        fetchScenario.fetchMock.mock.calls.some(
          ([input, init]) =>
            (init?.method ?? 'GET').toUpperCase() === 'DELETE' &&
            // eslint-disable-next-line @typescript-eslint/no-base-to-string -- The mock records the request target using JavaScript string conversion.
            String(input).includes('/external-agents/claude/disclosure')
        )
      ).toBe(true);
    });
  });

  /** Withdrawing is the safe direction, so it is never hidden behind a confirm. */
  it('warns that withdrawing stops a running turn', async () => {
    respondWithDisclosures(fetchScenario, [
      { targetId: 'claude', disclosureVersion: 1, acknowledgedAt: ACKNOWLEDGED_AT },
    ]);
    render(<ExternalAgentSettingsPage />);

    expect(await screen.findByText(/stops any turn running now/i)).toBeInTheDocument();
  });

  /** There is nothing to withdraw yet, so the page says what the notices are and how one appears. */
  it('explains the empty list instead of a Withdraw button nobody can see', async () => {
    respondWithDisclosures(fetchScenario, []);
    render(<ExternalAgentSettingsPage />);

    expect(
      await screen.findByText(/first time you run Claude Code, Codex or Cursor/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/stops any turn running now/i)).toBeNull();
  });

  describe('trusted folders', () => {
    const GRANT: TrustGrantFixture = {
      targetId: 'cursor',
      environmentId: 'local',
      workspacePath: '/home/dev/repo',
      version: 1,
      acceptedAt: ACKNOWLEDGED_AT,
    };

    it('lists each trusted folder with its vendor and machine', async () => {
      respondWithDisclosures(fetchScenario, []);
      respondWithTrustGrants(fetchScenario, [GRANT]);

      render(<ExternalAgentSettingsPage />);

      expect(await screen.findByText('/home/dev/repo')).toBeInTheDocument();
      expect(screen.getByText(/Cursor CLI · local · Trusted/)).toBeInTheDocument();
      // Withdrawing a folder reaches every chat on it, and says a running turn is spared.
      expect(screen.getByText(/A turn already running keeps going/i)).toBeInTheDocument();
    });

    it('says no folder is trusted only once the answer has arrived', async () => {
      respondWithDisclosures(fetchScenario, []);

      render(<ExternalAgentSettingsPage />);

      expect(screen.queryByText(/No trusted folders yet/i)).toBeNull();
      expect(await screen.findByText(/No trusted folders yet/i)).toBeInTheDocument();
    });

    it('withdraws exactly the folder whose row was clicked, by its stored key', async () => {
      respondWithDisclosures(fetchScenario, []);
      respondWithTrustGrants(fetchScenario, [GRANT]);
      fetchScenario.respondWithJson('DELETE', '/api/external-agents/workspace-trust', {
        body: { revoked: true },
      });

      render(<ExternalAgentSettingsPage />);
      await userEvent.click(await screen.findByRole('button', { name: /withdraw/i }));

      // The body is the assertion: a revoke that sent a re-spelled path, or only
      // part of the key, would match nothing server-side or the wrong grant.
      await waitFor(() => {
        const call = fetchScenario.fetchMock.mock.calls.find(
          ([, init]) => (init?.method ?? 'GET').toUpperCase() === 'DELETE'
        );
        const body = call?.[1]?.body;
        if (typeof body !== 'string') {
          throw new Error(
            `(workspace-trust revoke): expected a JSON string body | received: ${typeof body}`
          );
        }
        expect(JSON.parse(body)).toEqual({
          targetId: 'cursor',
          environmentId: 'local',
          workspacePath: '/home/dev/repo',
        });
      });
    });

    it('tells the user when a withdrawal did not go through', async () => {
      respondWithDisclosures(fetchScenario, []);
      respondWithTrustGrants(fetchScenario, [GRANT]);
      fetchScenario.respondWithJson('DELETE', '/api/external-agents/workspace-trust', {
        status: 404,
        body: { error: 'No trusted workspace matches that request.', code: 'NOT_FOUND' },
      });

      render(<ExternalAgentSettingsPage />);
      await userEvent.click(await screen.findByRole('button', { name: /withdraw/i }));

      expect(await screen.findByText(/could not be withdrawn/i)).toBeInTheDocument();
    });
  });
});
