/**
 * Runtime lifecycle panel: health summary, WSL actions, and copyable commands.
 */

import type { Environment, RuntimeLifecycleView } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeLifecyclePanel } from '../../../../src/features/environments/components/RuntimeLifecyclePanel';
import { formatMessage } from '../../../../src/lib/i18n-format';
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
            platformId: 'linux-x64',
            platformAssumed: false,
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
    expect(screen.getByTestId('manual-platform')).toHaveTextContent('linux-x64');
  });

  it('shows the live upgrade action for connected websocket and stdio runtimes', async () => {
    for (const [id, transportKind] of [
      ['dial-in-update', 'websocket'],
      ['stdio-update', 'stdio'],
    ] as const) {
      const environment: Environment = {
        ...WSL,
        id,
        transportKind,
        config: {},
        status: { state: 'connected' },
      };
      scenario
        .respondWithJson('GET', `/api/environments/${id}/runtime`, {
          body: { ...VIEW, actions: ['upgrade'] } satisfies RuntimeLifecycleView,
        })
        .install();
      const rendered = render(<RuntimeLifecyclePanel environment={environment} />);

      expect(
        await screen.findByRole('button', { name: labels.actions.upgrade })
      ).toBeInTheDocument();
      rendered.unmount();
      scenario.restore();
    }
  });

  // The block is read before a machine has ever paired, which is exactly when
  // the hub is guessing — so the copy has to say so rather than hand a Windows
  // user a Linux download.
  it('says so when the platform behind the manual commands is a guess', async () => {
    const websocket: Environment = {
      ...WSL,
      id: 'never-paired',
      transportKind: 'websocket',
      config: {},
    };
    scenario
      .respondWithJson('GET', '/api/environments/never-paired/runtime', {
        body: {
          health: null,
          readAt: null,
          stale: true,
          slotBytes: null,
          actions: [],
          manualCommands: {
            platformId: 'linux-x64',
            platformAssumed: true,
            install: 'curl -fsSL https://example.test/runtime -o mangostudio-runtime',
            verify: 'sha256sum -c -',
          },
        } satisfies RuntimeLifecycleView,
      })
      .install();
    render(<RuntimeLifecyclePanel environment={websocket} />);

    const note = await screen.findByTestId('manual-platform');
    expect(note).toHaveTextContent('linux-x64');
    expect(note.textContent).toBe(
      formatMessage(labels.manual.platformAssumed, { platform: 'linux-x64' })
    );
    expect(screen.getByText(labels.manual.verify)).toBeInTheDocument();
  });

  // A runtime too old to re-check tool paths on its own machine leaves a
  // restricted chat containable only lexically, which a symbolic link on that
  // machine defeats. The card is where an operator finds out.
  it('warns when a connected runtime does not enforce path containment', async () => {
    const connected: Environment = { ...WSL, id: 'legacy-peer', status: { state: 'connected' } };
    scenario
      .respondWithJson('GET', '/api/environments/legacy-peer/runtime', {
        body: { ...VIEW, enforcesPathPolicy: false } satisfies RuntimeLifecycleView,
      })
      .install();
    render(<RuntimeLifecyclePanel environment={connected} />);

    expect(await screen.findByTestId('runtime-unenforced-containment')).toHaveTextContent(
      labels.unenforcedContainment
    );
  });

  it.each([
    ['a peer that enforces', true],
    ['a peer that has not connected to answer', undefined],
  ])('stays silent about containment for %s', async (_case, enforcesPathPolicy) => {
    const environment: Environment = { ...WSL, id: `quiet-${String(enforcesPathPolicy)}` };
    scenario
      .respondWithJson('GET', `/api/environments/${environment.id}/runtime`, {
        body: {
          ...VIEW,
          ...(enforcesPathPolicy === undefined ? {} : { enforcesPathPolicy }),
        } satisfies RuntimeLifecycleView,
      })
      .install();
    render(<RuntimeLifecyclePanel environment={environment} />);

    await screen.findByTestId('runtime-lifecycle-panel');
    expect(screen.queryByTestId('runtime-unenforced-containment')).not.toBeInTheDocument();
  });
});
