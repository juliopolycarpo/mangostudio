/**
 * Runtime lifecycle panel: health summary, WSL actions, and copyable commands.
 */

import type { Environment, RuntimeLifecycleView } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeLifecyclePanel } from '../../../../src/features/environments/components/RuntimeLifecyclePanel';
import { render, screen, waitFor } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();
const labels = en.environments.entities.runtime;

const WSL: Environment = {
  id: 'ubuntu-box',
  name: 'Ubuntu',
  transportKind: 'wsl',
  config: { distro: 'Ubuntu' },
  enabled: true,
  allowInstalls: true,
  virtual: false,
  createdAt: 1,
  updatedAt: 1,
  status: { state: 'disconnected' },
};

const VIEW: RuntimeLifecycleView = {
  health: null,
  readAt: null,
  stale: true,
  slotBytes: null,
  actions: ['install', 'reinstall', 'upgrade'],
};

afterEach(() => {
  scenario.restore();
});

describe('RuntimeLifecyclePanel', () => {
  it('renders WSL install actions from the hub view', async () => {
    scenario
      .respondWithJson('GET', '/api/environments/ubuntu-box/runtime', { body: VIEW })
      .install();
    render(<RuntimeLifecyclePanel environment={WSL} />);

    await screen.findByTestId('runtime-lifecycle-panel');
    expect(screen.getByText(labels.title)).toBeInTheDocument();
    expect(screen.getByText(labels.stale)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: labels.actions.install })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: labels.actions.reinstall })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: labels.actions.upgrade })).toBeInTheDocument();
  });

  it('shows copyable manual commands for websocket environments', async () => {
    const websocket: Environment = {
      ...WSL,
      id: 'dial-in',
      transportKind: 'websocket',
      config: {},
    };
    scenario
      .respondWithJson('GET', '/api/environments/dial-in/runtime', {
        body: {
          health: null,
          readAt: null,
          stale: true,
          slotBytes: null,
          actions: [],
          manualCommands: {
            install: 'curl -fsSL https://example.test/runtime -o mangostudio-runtime',
            setup: './mangostudio-runtime setup --slot remote --profile full --yes',
          },
        } satisfies RuntimeLifecycleView,
      })
      .install();
    render(<RuntimeLifecyclePanel environment={websocket} />);

    await waitFor(() => {
      expect(screen.getByText(labels.manual.install)).toBeInTheDocument();
    });
    expect(
      screen.getByText('curl -fsSL https://example.test/runtime -o mangostudio-runtime')
    ).toBeInTheDocument();
  });
});
