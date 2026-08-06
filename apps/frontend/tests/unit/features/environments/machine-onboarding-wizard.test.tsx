/**
 * The guided flow, from the picker to the step that can refuse to continue.
 *
 * Two things here are worth more than the rest. The paired branch must not
 * advance past the end-state step when MangoStudio does not know its own public
 * address — provisioning a machine that has nowhere to dial is the failure this
 * flow exists to prevent. And the install permission must arrive unticked: it
 * is one half of a two-sided agreement, and a pre-ticked box is a decision
 * taken on somebody's behalf.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentEntitiesOverview } from '../../../../src/features/environments/components/EnvironmentEntitiesOverview';
import { render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();
const add = en.environments.entities.add;
const labels = en.environments.onboarding;

const NO_WSL = { available: false, distributions: [], reason: 'not-windows' as const };
const NO_CONTAINERS = { available: false, engines: [] };

const LOCAL: Environment = {
  id: 'local',
  name: 'Local',
  transportKind: 'in-process',
  config: {},
  enabled: true,
  allowInstalls: false,
  virtual: true,
  createdAt: null,
  updatedAt: null,
  status: { state: 'connected' },
};

const PAIRED: Environment = {
  id: 'vps',
  name: 'vps.example.test',
  transportKind: 'websocket',
  config: {},
  enabled: true,
  allowInstalls: false,
  virtual: false,
  createdAt: 1,
  updatedAt: 1,
  status: { state: 'disconnected' },
};

function createdRequestBody(): Record<string, unknown> {
  const call = scenario.fetchMock.mock.calls.find(([input, init]) => {
    const url = input instanceof Request ? input.url : String(input);
    return (
      (init as RequestInit | undefined)?.method?.toUpperCase() === 'POST' &&
      url.endsWith('/api/environments')
    );
  });
  const body = (call?.[1] as RequestInit | undefined)?.body;
  return JSON.parse(String(body)) as Record<string, unknown>;
}

/** Opens the picker and takes the guided answer out of it. */
async function openWizard(): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(<EnvironmentEntitiesOverview />);
  await screen.findByTestId('environment-entity-card');
  await user.click(screen.getByRole('button', { name: en.environments.entities.add.trigger }));
  const dialog = await screen.findByTestId('add-environment-dialog');
  await user.click(within(dialog).getByTestId('add-environment-onboarding'));
  return await screen.findByTestId('machine-onboarding-wizard');
}

beforeEach(() => {
  scenario
    .respondWithJson('GET', '/api/environments', { body: [LOCAL] })
    .respondWithJson('GET', '/api/environments/wsl', { body: NO_WSL })
    .respondWithJson('GET', '/api/environments/containers', { body: NO_CONTAINERS })
    .install();
});

afterEach(() => {
  scenario.restore();
});

describe('MachineOnboardingWizard', () => {
  it('opens from the reachability picker and starts on the ssh form', async () => {
    const wizard = await openWizard();

    expect(within(wizard).getByTestId('onboarding-reach-step')).toBeInTheDocument();
    // The add form is gone rather than stacked behind it: the guided answer
    // asks the same questions in its own order.
    expect(screen.queryByTestId('add-environment-dialog')).toBeNull();
  });

  it('says Windows is out of scope before anything is pushed', async () => {
    const wizard = await openWizard();

    expect(within(wizard).getByText(labels.reachWindows)).toBeInTheDocument();
  });

  it('will not continue past a host it could never reach', async () => {
    const user = userEvent.setup();
    const wizard = await openWizard();

    const advance = within(wizard).getByRole('button', { name: labels.continue });
    expect(advance).toBeDisabled();

    // A leading dash would arrive at ssh as an option, not a destination.
    await user.type(within(wizard).getByRole('textbox', { name: add.sshHostLabel }), '-oProxy=x');
    expect(within(wizard).getByRole('button', { name: labels.continue })).toBeDisabled();
  });

  it('creates an ssh environment from the host that was typed', async () => {
    scenario.respondWithJson('POST', '/api/environments', {
      body: { ...PAIRED, id: 'vps', transportKind: 'ssh', config: { host: 'vps.example.test' } },
      status: 201,
    });
    const user = userEvent.setup();
    const wizard = await openWizard();

    await user.type(
      within(wizard).getByRole('textbox', { name: add.sshHostLabel }),
      'vps.example.test'
    );
    await user.click(within(wizard).getByRole('button', { name: labels.continue }));

    const endState = await screen.findByTestId('onboarding-end-state-step');
    // The name defaults to the host, so the common case needs no second answer.
    expect(within(endState).getByRole('textbox', { name: add.nameLabel })).toHaveValue(
      'vps.example.test'
    );
    await user.click(within(endState).getByRole('button', { name: labels.continue }));

    await waitFor(() =>
      expect(createdRequestBody()).toEqual({
        id: 'vps-example-test',
        name: 'vps.example.test',
        transportKind: 'ssh',
        config: { host: 'vps.example.test' },
      })
    );
  });

  it('refuses the paired end state while the hub has no public address', async () => {
    scenario
      .respondWithJson('POST', '/api/environments', { body: PAIRED, status: 201 })
      // The hub answers with no dial address: `server.publicUrl` is unset.
      .respondWithJson('GET', '/api/environments/vps/pairing', {
        body: { endpoint: null, token: null },
      })
      .respondWithJson('GET', '/api/environments/vps/runtime', {
        body: { health: null, readAt: null, stale: true, slotBytes: null, actions: [] },
      });
    const user = userEvent.setup();
    const wizard = await openWizard();

    await user.type(
      within(wizard).getByRole('textbox', { name: add.sshHostLabel }),
      'vps.example.test'
    );
    await user.click(within(wizard).getByRole('button', { name: labels.continue }));

    const endState = await screen.findByTestId('onboarding-end-state-step');
    await user.click(within(endState).getByRole('radio', { name: labels.endStatePaired }));
    // The row the POST creates is what the gate can ask about, so the list has
    // to carry it from the refetch the mutation triggers.
    scenario.respondWithJson('GET', '/api/environments', { body: [LOCAL, PAIRED] });
    await user.click(within(endState).getByRole('button', { name: labels.continue }));

    // The row exists — it is the flow's anchor — but the machine has not been
    // touched, and the gate names the setting rather than the step that failed.
    const gate = await screen.findByTestId('onboarding-public-url-gate');
    expect(gate).toHaveTextContent(en.environments.entities.pairing.endpointUnset);
    expect(screen.getByTestId('onboarding-end-state-step')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-provision-step')).toBeNull();
  });

  it('says so and offers another go when the gate itself cannot be asked', async () => {
    scenario
      .respondWithJson('POST', '/api/environments', { body: PAIRED, status: 201 })
      // Not "no address" — no answer at all. The gate has to hold, and holding
      // silently behind a disabled button is the failure this covers.
      .respondWithJson('GET', '/api/environments/vps/pairing', {
        body: { code: 'internal_error', message: 'nope' },
        status: 500,
      })
      .respondWithJson('GET', '/api/environments/vps/runtime', {
        body: { health: null, readAt: null, stale: true, slotBytes: null, actions: [] },
      });
    const user = userEvent.setup();
    const wizard = await openWizard();

    await user.type(
      within(wizard).getByRole('textbox', { name: add.sshHostLabel }),
      'vps.example.test'
    );
    await user.click(within(wizard).getByRole('button', { name: labels.continue }));

    const endState = await screen.findByTestId('onboarding-end-state-step');
    await user.click(within(endState).getByRole('radio', { name: labels.endStatePaired }));
    scenario.respondWithJson('GET', '/api/environments', { body: [LOCAL, PAIRED] });
    await user.click(within(endState).getByRole('button', { name: labels.continue }));

    const failure = await screen.findByTestId('onboarding-pairing-error');
    expect(failure).toHaveTextContent(labels.endStatePairingUnavailable);
    expect(screen.getByRole('button', { name: labels.continue })).toBeDisabled();

    // The retry is the whole point: once the hub answers, the flow moves on
    // without making anyone reopen the wizard.
    scenario.respondWithJson('GET', '/api/environments/vps/pairing', {
      body: { endpoint: 'https://hub.example.test/api/runtime', token: null },
    });
    await user.click(screen.getByRole('button', { name: labels.endStatePairingRetry }));

    await waitFor(() => expect(screen.queryByTestId('onboarding-pairing-error')).toBeNull());
    await user.click(screen.getByRole('button', { name: labels.continue }));
    expect(await screen.findByTestId('onboarding-permissions-step')).toBeInTheDocument();
  });
});
