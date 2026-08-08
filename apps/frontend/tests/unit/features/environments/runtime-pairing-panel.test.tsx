/**
 * A pairing token is readable exactly once, which makes what this panel shows —
 * and when it stops showing it — part of the security story rather than a
 * presentation detail.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentEntitiesOverview } from '../../../../src/features/environments/components/EnvironmentEntitiesOverview';
import { render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();
const labels = en.environments.entities.pairing;
const addLabels = en.environments.entities.add;

const TOKEN = 'mrt_selector.thesecrethalf';
const ENDPOINT = 'wss://hub.example.com/api/runtime';

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
  id: 'workshop',
  name: 'Workshop',
  transportKind: 'websocket',
  config: {},
  enabled: true,
  allowInstalls: false,
  virtual: false,
  createdAt: 1,
  updatedAt: 1,
  status: { state: 'disconnected' },
};

function panel(): Promise<HTMLElement> {
  return screen.findByTestId('runtime-pairing-panel');
}

beforeEach(() => {
  scenario
    .respondWithJson('GET', '/api/environments', { body: [LOCAL, PAIRED] })
    .respondWithJson('GET', '/api/environments/wsl', {
      body: { available: false, distributions: [], reason: 'not-windows' },
    })
    .respondWithJson('GET', '/api/environments/workshop/runtime', {
      body: {
        health: null,
        readAt: null,
        stale: true,
        slotBytes: null,
        actions: [],
        manualCommands: {
          install: 'curl …',
          setup: 'mangostudio-runtime setup --slot remote --profile full --yes',
        },
      },
    })
    .respondWithJson('GET', '/api/environments/workshop/pairing', {
      body: { endpoint: ENDPOINT, token: null },
    })
    .respondWithJson('POST', '/api/environments/workshop/pairing', {
      body: { environmentId: 'workshop', createdAt: 1, lastSeenAt: null, token: TOKEN },
      status: 201,
    })
    .install();
});

afterEach(() => {
  scenario.restore();
});

describe('RuntimePairingPanel', () => {
  it('shows the panel only for environments the runtime dials into', async () => {
    render(<EnvironmentEntitiesOverview />);
    await screen.findByTestId('runtime-pairing-panel');

    // Local is in-process; nothing dials in, so there is no credential to hold.
    expect(screen.getAllByTestId('runtime-pairing-panel')).toHaveLength(1);
  });

  it('reports that no token exists yet', async () => {
    render(<EnvironmentEntitiesOverview />);

    expect(within(await panel()).getByText(labels.noToken)).toBeInTheDocument();
  });

  it('prints the connect command with the token piped in, never as an argument', async () => {
    const user = userEvent.setup();
    render(<EnvironmentEntitiesOverview />);
    await user.click(within(await panel()).getByRole('button', { name: labels.issue }));

    const [posix, powershell] = await within(await panel()).findAllByText(
      /mangostudio-runtime connect/
    );
    expect(posix?.textContent).toContain(`printf %s '${TOKEN}'`);
    expect(posix?.textContent).toContain(`--hub ${ENDPOINT}`);
    expect(posix?.textContent).toContain('--token -');
    // `printf` and single quotes are neither `cmd.exe` nor PowerShell, so a
    // Windows operator following the POSIX line gets a parse error rather than
    // a paired machine. The environment variable is the documented second way
    // in, and it keeps the secret out of argv the same way.
    expect(powershell?.textContent).toContain(`$env:MANGOSTUDIO_RUNTIME_TOKEN='${TOKEN}'`);
    expect(powershell?.textContent).toContain(`--hub ${ENDPOINT}`);
    // `--token <secret>` would put the credential in a command line every
    // process on that machine can read.
    for (const line of [posix, powershell]) {
      expect(line?.textContent).not.toContain(`--token ${TOKEN}`);
    }
  });

  it('warns when the hub has not been told its own public address', async () => {
    scenario.respondWithJson('GET', '/api/environments/workshop/pairing', {
      body: { endpoint: null, token: null },
    });
    const user = userEvent.setup();
    render(<EnvironmentEntitiesOverview />);

    expect(within(await panel()).getByText(labels.endpointUnset)).toBeInTheDocument();

    await user.click(within(await panel()).getByRole('button', { name: labels.issue }));
    const commands = await within(await panel()).findAllByText(/mangostudio-runtime connect/);
    // A placeholder, not a guess: the request's own Host header is spoofable.
    for (const command of commands) {
      expect(command.textContent).toContain(labels.endpointPlaceholder);
    }
  });

  it('offers rotation and revocation once a token exists', async () => {
    scenario.respondWithJson('GET', '/api/environments/workshop/pairing', {
      body: {
        endpoint: ENDPOINT,
        token: { environmentId: 'workshop', createdAt: 1, lastSeenAt: null },
      },
    });
    render(<EnvironmentEntitiesOverview />);

    const section = await panel();
    await waitFor(() =>
      expect(within(section).getByRole('button', { name: labels.rotate })).toBeInTheDocument()
    );
    expect(within(section).getByRole('button', { name: labels.revoke })).toBeInTheDocument();
    expect(within(section).getByText(labels.neverSeen)).toBeInTheDocument();
  });
});

describe('Add Environment reachability picker', () => {
  it('creates a paired environment with no hub-side configuration', async () => {
    scenario.respondWithJson('POST', '/api/environments', { body: PAIRED, status: 201 });
    const user = userEvent.setup();
    render(<EnvironmentEntitiesOverview />);
    await screen.findByTestId('runtime-pairing-panel');
    await user.click(screen.getByRole('button', { name: addLabels.trigger }));

    const dialog = await screen.findByTestId('add-environment-dialog');
    await user.click(within(dialog).getByRole('tab', { name: addLabels.reachPaired }));
    await user.type(within(dialog).getByRole('textbox', { name: addLabels.nameLabel }), 'Workshop');
    await user.click(within(dialog).getByRole('button', { name: addLabels.submit }));

    await waitFor(() => expect(screen.queryByTestId('add-environment-dialog')).toBeNull());
    const call = scenario.fetchMock.mock.calls.find(
      ([input, init]) =>
        (init as RequestInit | undefined)?.method?.toUpperCase() === 'POST' &&
        String(input instanceof Request ? input.url : input).endsWith('/api/environments')
    );
    expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({
      id: 'workshop',
      name: 'Workshop',
      transportKind: 'websocket',
      config: {},
    });
  });
});
