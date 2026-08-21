/**
 * The two steps that carry a decision, rendered on their own.
 *
 * Permissions is where the consent surface has to be the shared one rather than
 * a copy written for a wizard, and where the paired branch must record an
 * answer without sending it anywhere — there is no channel to that machine yet.
 * Tools is where the install permission has to arrive unticked.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { Environment } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { PermissionsStep } from '../../../../src/features/environments/onboarding/PermissionsStep';
import { ToolsStep } from '../../../../src/features/environments/onboarding/ToolsStep';
import { render, screen, waitFor } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();
const labels = en.environments.onboarding;
const consentLabels = en.environments.entities.runtime.consent;
const permissionLabels = en.environments.entities.permissions;

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
  status: { state: 'connected' },
};

function postCount(path: string): number {
  return scenario.fetchMock.mock.calls.filter(([input, init]) => {
    const url = input instanceof Request ? input.url : String(input);
    return (
      (init as RequestInit | undefined)?.method?.toUpperCase() === 'POST' && url.includes(path)
    );
  }).length;
}

beforeEach(() => {
  scenario
    .respondWithJson('GET', '/api/environments', { body: [PAIRED] })
    .respondWithJson('GET', '/api/environments/runtimes?environmentId=vps', { body: [] })
    .respondWithJson('GET', '/api/environments/agents?environmentId=vps', { body: [] })
    .install();
});

afterEach(() => {
  scenario.restore();
});

describe('PermissionsStep', () => {
  it('asks with the shared consent surface, honesty copy included', async () => {
    const user = userEvent.setup();
    render(
      <PermissionsStep
        host="vps.example.test"
        consent={null}
        environment={PAIRED}
        endState="paired"
        onConsent={() => undefined}
        onContinue={() => undefined}
      />
    );

    await user.click(screen.getByTestId('onboarding-open-consent'));

    const dialog = await screen.findByTestId('runtime-consent-dialog');
    expect(dialog).toHaveTextContent(permissionLabels.allowShellHonesty);
    // Named for the machine, not for the wizard: the confirm says where this
    // is about to be recorded.
    expect(dialog).toHaveTextContent('vps.example.test');
  });

  it('records a paired answer without sending it anywhere yet', async () => {
    const onConsent = jest.fn();
    const user = userEvent.setup();
    render(
      <PermissionsStep
        host="vps.example.test"
        consent={null}
        environment={PAIRED}
        endState="paired"
        onConsent={onConsent}
        onContinue={() => undefined}
      />
    );

    await user.click(screen.getByTestId('onboarding-open-consent'));
    await user.click(
      await screen.findByRole('button', { name: permissionLabels.profile.readonly })
    );
    await user.click(screen.getByRole('button', { name: /vps\.example\.test/ }));

    await waitFor(() => expect(onConsent).toHaveBeenCalledWith({ profile: 'readonly' }));
    // There is no channel to that machine at this point in the paired flow;
    // the answer travels with the bootstrap run in the next step.
    expect(postCount('/runtime/setup')).toBe(0);
  });

  it('cannot continue before an answer exists', () => {
    render(
      <PermissionsStep
        host="vps.example.test"
        consent={null}
        environment={PAIRED}
        endState="paired"
        onConsent={() => undefined}
        onContinue={() => undefined}
      />
    );

    expect(screen.getByRole('button', { name: labels.continue })).toBeDisabled();
    expect(screen.getByText(labels.permissionsNone)).toBeInTheDocument();
  });
});

describe('ToolsStep', () => {
  it('offers the install permission unticked', async () => {
    render(<ToolsStep environment={PAIRED} onContinue={() => undefined} />);

    const toggle = await screen.findByTestId('install-trust-toggle');
    // Two sides have to agree before a recipe runs there. A box that arrives
    // ticked has answered one of them for the user.
    expect(toggle).not.toBeChecked();
  });

  it('says nothing was found rather than implying nothing is there', async () => {
    render(<ToolsStep environment={PAIRED} onContinue={() => undefined} />);

    expect(await screen.findByText(labels.toolsNone)).toBeInTheDocument();
  });
});

describe('consent dialog reuse', () => {
  it('uses the same confirm wording the environment card does', async () => {
    const user = userEvent.setup();
    render(
      <PermissionsStep
        host="vps.example.test"
        consent={null}
        environment={PAIRED}
        endState="paired"
        onConsent={() => undefined}
        onContinue={() => undefined}
      />
    );

    await user.click(screen.getByTestId('onboarding-open-consent'));

    const confirm = consentLabels.confirm.replace('{name}', 'vps.example.test');
    expect(await screen.findByRole('button', { name: confirm })).toBeInTheDocument();
  });
});
