/**
 * Creating an environment is the first place a user can point MangoStudio at a
 * process other than its own, so what the form sends matters as much as what it
 * shows: an optional field left blank must be absent from the request rather
 * than present and empty, which the launcher would try to spawn.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  virtual: false,
  createdAt: 1,
  updatedAt: 1,
  status: { state: 'disconnected' },
};

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
  it('hides the WSL tab on a host that has no WSL', async () => {
    const dialog = await openDialog();

    expect(within(dialog).getByText(labels.stdioSummary)).toBeInTheDocument();
    expect(within(dialog).queryByRole('tab', { name: labels.wslSummary })).toBeNull();
    // The kinds later plans add must not appear before they can connect.
    expect(within(dialog).queryByText(en.environments.entities.transport.ssh)).toBeNull();
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

  it('sends the advanced overrides when they are filled in', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.type(within(dialog).getByRole('textbox', { name: labels.nameLabel }), 'Build host');
    await user.type(
      within(dialog).getByRole('textbox', {
        name: `${labels.binaryPathLabel} · ${labels.optional}`,
      }),
      '/opt/mango/mangostudio-runtime'
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: `${labels.cwdLabel} · ${labels.optional}` }),
      '/srv/build'
    );
    await user.click(within(dialog).getByRole('button', { name: labels.submit }));

    await waitFor(() => expect(screen.queryByTestId('add-environment-dialog')).toBeNull());
    expect(createdRequestBody().config).toEqual({
      binaryPath: '/opt/mango/mangostudio-runtime',
      cwd: '/srv/build',
    });
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

describe('AddEnvironmentDialog WSL tab', () => {
  beforeEach(() => {
    scenario.respondWithJson('GET', '/api/environments/wsl', { body: WSL });
  });

  it('preselects the host default and names the environment after it', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('tab', { name: labels.wslSummary }));

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

    await user.click(within(dialog).getByRole('tab', { name: labels.wslSummary }));
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

    await user.click(within(dialog).getByRole('tab', { name: labels.wslSummary }));
    const list = await within(dialog).findByTestId('wsl-distribution-list');

    const configured = within(list).getByRole('button', { name: /docker-desktop/ });
    expect(configured).toBeDisabled();
    expect(configured).toHaveTextContent('docker');
  });

  it('drops the stdio-only fields while the WSL tab is open', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole('tab', { name: labels.wslSummary }));

    expect(
      within(dialog).queryByRole('textbox', {
        name: `${labels.binaryPathLabel} · ${labels.optional}`,
      })
    ).toBeNull();
  });
});
