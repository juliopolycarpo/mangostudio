/**
 * The SSH panel is where the several unrelated ways an ssh launch fails become
 * different sentences, and where the one step MangoStudio cannot take for the
 * user — accepting a host key — is handed back as a command they can run.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvironmentEntitiesOverview } from '../../../../src/features/environments/components/EnvironmentEntitiesOverview';
import { render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();
const labels = en.environments.entities.ssh;
const optional = en.environments.entities.add.optional;

const LOCAL: Environment = {
  id: 'local',
  name: 'Local',
  transportKind: 'in-process',
  config: {},
  enabled: true,
  virtual: true,
  createdAt: null,
  updatedAt: null,
  status: { state: 'connected' },
};

function sshEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: 'build-01',
    name: 'Build 01',
    transportKind: 'ssh',
    config: { host: 'build-01.internal', user: 'deploy' },
    enabled: true,
    virtual: false,
    createdAt: 1,
    updatedAt: 1,
    status: { state: 'disconnected' },
    ...overrides,
  };
}

function mount(environment: Environment): void {
  scenario
    .respondWithJson('GET', '/api/environments', { body: [LOCAL, environment] })
    .respondWithJson('GET', '/api/environments/wsl', {
      body: { available: false, distributions: [], reason: 'not-windows' },
    })
    .respondWithJson('PUT', '/api/environments/build-01', { body: environment })
    .install();
  render(<EnvironmentEntitiesOverview />);
}

function savedBody(): Record<string, unknown> {
  const call = scenario.fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method?.toUpperCase() === 'PUT'
  );
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  scenario.restore();
});

describe('SshPanel', () => {
  it('prints the reachability check for the configured destination', async () => {
    mount(sshEnvironment());
    const panel = await screen.findByTestId('ssh-panel');

    // Without the forced batch-mode options the hub uses: this is the command
    // that is allowed to prompt, which is how a host key gets trusted.
    expect(within(panel).getByText("ssh 'deploy@build-01.internal' true")).toBeInTheDocument();
    expect(
      within(panel).getByText(
        "ssh 'deploy@build-01.internal' \\~/'.mango/runtime/remote/current/mangostudio-runtime' --version"
      )
    ).toBeInTheDocument();
  });

  it('says what to do about the specific failure, not that something failed', async () => {
    mount(
      sshEnvironment({
        status: {
          state: 'error',
          errorCode: 'RUNTIME_UNAVAILABLE',
          sshFailureReason: 'host-key-unverified',
        },
      })
    );

    const reason = await screen.findByTestId('ssh-failure-reason');
    expect(reason).toHaveTextContent(labels.reason['host-key-unverified']);
    expect(reason).not.toHaveTextContent(labels.reason['runtime-missing']);
  });

  it('shows nothing about failures on an environment that has not failed', async () => {
    mount(sshEnvironment());
    await screen.findByTestId('ssh-panel');

    expect(screen.queryByTestId('ssh-failure-reason')).toBeNull();
  });

  it('saves a corrected runtime path without sending the untouched fields empty', async () => {
    const user = userEvent.setup();
    mount(sshEnvironment());
    const panel = await screen.findByTestId('ssh-panel');

    await user.type(
      within(panel).getByRole('textbox', { name: `${labels.runtimePathLabel} · ${optional}` }),
      '/opt/mango/mangostudio-runtime'
    );
    await user.click(within(panel).getByRole('button', { name: labels.save }));

    await waitFor(() => expect(savedBody()).toBeDefined());
    expect(savedBody()).toEqual({
      config: {
        host: 'build-01.internal',
        user: 'deploy',
        remoteRuntimePath: '/opt/mango/mangostudio-runtime',
      },
    });
  });

  it('refuses to save a value that would read as an ssh option', async () => {
    const user = userEvent.setup();
    mount(sshEnvironment());
    const panel = await screen.findByTestId('ssh-panel');

    const host = within(panel).getByRole('textbox', { name: labels.hostLabel });
    await user.clear(host);
    await user.type(host, '-oProxyCommand=id');

    expect(within(panel).getByText(labels.hostInvalid)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: labels.save })).toBeDisabled();
  });

  it('keeps Save inert until something actually changed', async () => {
    mount(sshEnvironment());
    const panel = await screen.findByTestId('ssh-panel');

    expect(within(panel).getByRole('button', { name: labels.save })).toBeDisabled();
  });
});
