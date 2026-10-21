/**
 * Creating an environment is the first place a user can point MangoStudio at a
 * process other than its own, so what the form sends matters as much as what it
 * shows: an optional field left blank must be absent from the request rather
 * than present and empty, which the launcher would try to spawn.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Environment } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { EnvironmentEntitiesOverview } from '../../../../src/features/environments/components/EnvironmentEntitiesOverview';
import { render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();
const labels = en.environments.entities.add;

const NO_WSL = { available: false, distributions: [], reason: 'not-windows' as const };
const WSL = {
  available: true,
  distributions: [
    { name: 'Debian', state: 'Stopped', wslVersion: 2, default: false },
    { name: 'Ubuntu-22.04', state: 'Running', wslVersion: 2, default: true },
    {
      name: 'docker-desktop',
      state: 'Running',
      wslVersion: 2,
      default: false,
      environmentId: 'docker',
    },
  ],
};

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

const CREATED: Environment = {
  id: 'build-host',
  name: 'Build host',
  transportKind: 'stdio',
  config: {},
  enabled: true,
  allowInstalls: false,
  virtual: false,
  createdAt: 1,
  updatedAt: 1,
  status: { state: 'disconnected' },
};

function wslRequestCount(): number {
  return scenario.fetchMock.mock.calls.filter(([input]) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes('/api/environments/wsl');
  }).length;
}

function createdRequestBody(): Record<string, unknown> {
  const call = scenario.fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method?.toUpperCase() === 'POST'
  );
  const body = (call?.[1] as RequestInit | undefined)?.body;
  return JSON.parse(String(body)) as Record<string, unknown>;
}

async function openDialog(): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(<EnvironmentEntitiesOverview />);
  await screen.findByTestId('environment-entity-card');
  await user.click(screen.getByRole('button', { name: labels.trigger }));
  return await screen.findByTestId('add-environment-dialog');
}

beforeEach(() => {
  scenario
    .respondWithJson('GET', '/api/environments', { body: [LOCAL] })
    .respondWithJson('POST', '/api/environments', { body: CREATED, status: 201 })
    .respondWithJson('GET', '/api/environments/wsl', { body: NO_WSL })
    .install();
});

afterEach(() => {
  scenario.restore();
});

describe('AddEnvironmentDialog', () => {
  it('hides the WSL answer on a host that has no WSL', async () => {
    const dialog = await openDialog();

    expect(within(dialog).getByRole('radio', { name: labels.reachLocal })).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: labels.reachWsl })).toBeNull();
    // Every other answer is host-independent: only WSL depends on what this
    // machine has.
    expect(within(dialog).getByRole('radio', { name: labels.reachDirect })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: labels.reachSsh })).toBeInTheDocument();
  });

  // One question, one answer: a radio group under its legend, not a strip of
  // tabs with no panel behind them.
  it('offers the answers as one radio group with the chosen one checked', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    const group = within(dialog).getByRole('group', { name: labels.reachLabel });
    expect(within(dialog).queryByRole('tablist')).toBeNull();
    expect(within(group).getByRole('radio', { name: labels.reachLocal })).toBeChecked();

    await user.click(within(group).getByRole('radio', { name: labels.reachSsh }));

    expect(within(group).getByRole('radio', { name: labels.reachSsh })).toBeChecked();
    expect(within(group).getByRole('radio', { name: labels.reachLocal })).not.toBeChecked();
    // The explanation of the answer sits with the tiles, and the guided flow
    // is an action beside them rather than one more answer.
    expect(within(dialog).getByText(labels.sshHint)).toBeInTheDocument();
    expect(within(group).queryByTestId('add-environment-onboarding')).toBeNull();
    expect(within(dialog).getByTestId('add-environment-onboarding')).toBeInTheDocument();
  });

  // Leaving for the guided flow is not a field of the form and not an answer to
  // it, so it sits with the dialog's own actions, ahead of Cancel.
  it('puts the guided setup in the footer, apart from the form', async () => {
    const dialog = await openDialog();

    const guided = within(dialog).getByTestId('add-environment-onboarding');
    const footer = guided.closest('footer');
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByRole('button', { name: labels.cancel })).toBeTruthy();
    expect(guided).toHaveTextContent(labels.reachNewMachine);
    expect(guided).toHaveAttribute('title', labels.newMachineHint);
  });

  // The request does without these, which the heading says once rather than a
  // suffix on every label.
  it('groups the fields the request does without under one heading', async () => {
    const dialog = await openDialog();

    const optional = within(dialog).getByRole('group', { name: labels.optional });
    expect(
      within(optional).getByRole('textbox', { name: labels.binaryPathLabel })
    ).toBeInTheDocument();
    expect(within(optional).getByRole('textbox', { name: labels.cwdLabel })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('textbox', { name: labels.nameLabel }).closest('fieldset')
    ).toBeNull();
  });

  it('derives an identifier from the name and creates the environment', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.type(within(dialog).getByRole('textbox', { name: labels.nameLabel }), 'Build Host');
    expect(within(dialog).getByRole('textbox', { name: labels.idLabel })).toHaveValue('build-host');

    await user.click(within(dialog).getByRole('button', { name: labels.submit }));

    await waitFor(() => expect(screen.queryByTestId('add-environment-dialog')).toBeNull());
    expect(createdRequestBody()).toEqual({
      id: 'build-host',
      name: 'Build Host',
      transportKind: 'stdio',
      // Both optional fields were left blank, so neither is sent: an empty
      // binaryPath is a path the launcher would try to spawn.
      config: {},
    });
  });

  it('keeps an identifier the user typed instead of tracking the name', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.type(within(dialog).getByRole('textbox', { name: labels.idLabel }), 'devbox');
    await user.type(within(dialog).getByRole('textbox', { name: labels.nameLabel }), 'Build Host');

    expect(within(dialog).getByRole('textbox', { name: labels.idLabel })).toHaveValue('devbox');
  });

  it('refuses an identifier the server would reject', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.type(within(dialog).getByRole('textbox', { name: labels.nameLabel }), 'Build host');
    await user.clear(within(dialog).getByRole('textbox', { name: labels.idLabel }));
    await user.type(within(dialog).getByRole('textbox', { name: labels.idLabel }), 'Build Host!');

    expect(within(dialog).getByText(labels.idInvalid)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: labels.submit })).toBeDisabled();
  });

  it('creates a Direct URL environment with base URL and token', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: labels.reachDirect }));
    await user.type(within(dialog).getByRole('textbox', { name: labels.nameLabel }), 'LAN box');
    await user.type(
      within(dialog).getByRole('textbox', { name: labels.directBaseUrlLabel }),
      'http://192.168.1.10:8787'
    );
    await user.type(within(dialog).getByLabelText(labels.directTokenLabel), 'serve-secret-token');
    await user.click(within(dialog).getByRole('button', { name: labels.submit }));

    await waitFor(() => expect(screen.queryByTestId('add-environment-dialog')).toBeNull());
    expect(createdRequestBody()).toEqual({
      id: 'lan-box',
      name: 'LAN box',
      transportKind: 'http',
      config: { baseUrl: 'http://192.168.1.10:8787' },
      token: 'serve-secret-token',
    });
  });

  it('sends the advanced overrides when they are filled in', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.type(within(dialog).getByRole('textbox', { name: labels.nameLabel }), 'Build host');
    await user.type(
      within(dialog).getByRole('textbox', {
        name: labels.binaryPathLabel,
      }),
      '/opt/mango/mangostudio-runtime'
    );
    await user.type(within(dialog).getByRole('textbox', { name: labels.cwdLabel }), '/srv/build');
    await user.click(within(dialog).getByRole('button', { name: labels.submit }));

    await waitFor(() => expect(screen.queryByTestId('add-environment-dialog')).toBeNull());
    expect(createdRequestBody().config).toEqual({
      binaryPath: '/opt/mango/mangostudio-runtime',
      cwd: '/srv/build',
    });
  });

  it('creates an SSH environment and sends only the fields that were filled in', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: labels.reachSsh }));
    await user.type(within(dialog).getByRole('textbox', { name: labels.nameLabel }), 'Build host');
    await user.type(
      within(dialog).getByRole('textbox', { name: labels.sshHostLabel }),
      'build-01.internal'
    );
    await user.type(
      within(dialog).getByRole('textbox', {
        name: labels.sshUserLabel,
      }),
      'deploy'
    );
    await user.click(within(dialog).getByRole('button', { name: labels.submit }));

    await waitFor(() => expect(screen.queryByTestId('add-environment-dialog')).toBeNull());
    expect(createdRequestBody()).toEqual({
      id: 'build-host',
      name: 'Build host',
      transportKind: 'ssh',
      // Port, identity file and runtime path were blank, so ssh and the
      // launcher pick their own defaults rather than being handed empty argv.
      config: { host: 'build-01.internal', user: 'deploy' },
    });
  });

  it('offers the manual reachability check once a host is named', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: labels.reachSsh }));
    expect(within(dialog).queryByText(labels.sshPreflightReach)).toBeNull();

    await user.type(
      within(dialog).getByRole('textbox', { name: labels.sshHostLabel }),
      'build-01.internal'
    );

    // The command has to be the one that can prompt: accepting a host key is
    // exactly what MangoStudio refuses to do on the user's behalf. Ambient
    // RemoteCommand is still cleared so a pasted probe is not swallowed by
    // ssh_config the way a hub launch would be.
    const command = within(dialog).getByText("ssh -o RemoteCommand=none 'build-01.internal' true");
    expect(command).toBeInTheDocument();
  });

  it('refuses a host that would read as an ssh option', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: labels.reachSsh }));
    await user.type(within(dialog).getByRole('textbox', { name: labels.nameLabel }), 'Build host');
    await user.type(
      within(dialog).getByRole('textbox', { name: labels.sshHostLabel }),
      '-oProxyCommand=id'
    );

    expect(within(dialog).getByText(labels.sshDashInvalid)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: labels.submit })).toBeDisabled();
  });

  it('refuses a port that is not a port', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: labels.reachSsh }));
    await user.type(within(dialog).getByRole('textbox', { name: labels.nameLabel }), 'Build host');
    await user.type(
      within(dialog).getByRole('textbox', { name: labels.sshHostLabel }),
      'build-01.internal'
    );
    await user.type(within(dialog).getByRole('textbox', { name: labels.sshPortLabel }), '22abc');

    expect(within(dialog).getByRole('button', { name: labels.submit })).toBeDisabled();
  });

  it('keeps the form open and explains a rejected creation', async () => {
    const user = userEvent.setup();
    scenario.respondWithJson('POST', '/api/environments', {
      status: 409,
      body: { error: 'Environment "build-host" already exists.', code: 'CONFLICT' },
    });
    const dialog = await openDialog();

    await user.type(within(dialog).getByRole('textbox', { name: labels.nameLabel }), 'Build host');
    await user.click(within(dialog).getByRole('button', { name: labels.submit }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByTestId('add-environment-dialog')).toBeInTheDocument();
  });
});

describe('AddEnvironmentDialog WSL answer', () => {
  beforeEach(() => {
    scenario.respondWithJson('GET', '/api/environments/wsl', { body: WSL });
  });

  it('preselects the host default and names the environment after it', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: labels.reachWsl }));

    const list = await within(dialog).findByTestId('wsl-distribution-list');
    // The host says which distribution is default; nothing here is hardcoded.
    expect(within(list).getByRole('button', { name: /Ubuntu-22\.04/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(dialog).getByRole('textbox', { name: labels.nameLabel })).toHaveValue(
      'Ubuntu-22.04'
    );
    expect(within(dialog).getByRole('textbox', { name: labels.idLabel })).toHaveValue(
      'ubuntu-22-04'
    );
  });

  it('creates an environment for the distribution the user picks', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: labels.reachWsl }));
    const list = await within(dialog).findByTestId('wsl-distribution-list');
    await user.click(within(list).getByRole('button', { name: /Debian/ }));
    await user.click(within(dialog).getByRole('button', { name: labels.submit }));

    await waitFor(() => expect(screen.queryByTestId('add-environment-dialog')).toBeNull());
    expect(createdRequestBody()).toEqual({
      id: 'debian',
      name: 'Debian',
      transportKind: 'wsl',
      config: { distro: 'Debian' },
    });
  });

  it('shows a configured distribution but does not offer it again', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: labels.reachWsl }));
    const list = await within(dialog).findByTestId('wsl-distribution-list');

    const configured = within(list).getByRole('button', { name: /docker-desktop/ });
    expect(configured).toBeDisabled();
    expect(configured).toHaveTextContent('docker');
  });

  it('refreshes the listing once a distribution has been claimed', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();
    await waitFor(() => expect(wslRequestCount()).toBe(1));

    await user.click(within(dialog).getByRole('radio', { name: labels.reachWsl }));
    const list = await within(dialog).findByTestId('wsl-distribution-list');
    await user.click(within(list).getByRole('button', { name: /Debian/ }));
    await user.click(within(dialog).getByRole('button', { name: labels.submit }));

    await waitFor(() => expect(screen.queryByTestId('add-environment-dialog')).toBeNull());
    // Which distributions are configured is derived from the environments list,
    // so creating one dates the listing. Left alone it keeps serving the old
    // answer for its whole staleTime and offers this distribution again.
    await waitFor(() => expect(wslRequestCount()).toBe(2));
  });

  it('drops the stdio-only fields while the WSL answer is chosen', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('radio', { name: labels.reachWsl }));

    expect(
      within(dialog).queryByRole('textbox', {
        name: labels.binaryPathLabel,
      })
    ).toBeNull();
  });
});
