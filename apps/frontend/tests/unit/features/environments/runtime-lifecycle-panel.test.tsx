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

  // stdio has no install buttons and may have no health yet. The card still
  // has to say the connected peer will not re-check paths, or the warning
  // exists only for transports that already had something else to show.
  it('warns about unenforced containment even when the card has nothing else', async () => {
    const stdio: Environment = {
      ...WSL,
      id: 'legacy-stdio',
      transportKind: 'stdio',
      config: {},
      status: { state: 'connected' },
    };
    scenario
      .respondWithJson('GET', '/api/environments/legacy-stdio/runtime', {
        body: {
          health: null,
          readAt: null,
          stale: false,
          slotBytes: null,
          actions: [],
          enforcesPathPolicy: false,
        } satisfies RuntimeLifecycleView,
      })
      .install();
    render(<RuntimeLifecyclePanel environment={stdio} />);

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

  // #800: the offer rendered on every card with a push action, so a healthy,
  // up-to-date machine read as though the matching runtime were still missing.
  // Version equality settles it on a rolling channel too: a canary build's
  // version carries its own commit, and only the asset filename is reused.
  describe('runtime offer', () => {
    const STAGED = {
      version: '9.9.9',
      platformId: 'linux-x64',
      assetName: 'mangostudio-runtime-9.9.9-linux-x64',
      path: '/home/test/.mango/runtime-cache/9.9.9/mangostudio-runtime-9.9.9-linux-x64',
      verify: 'sha256sum -c -',
      present: false,
    };

    function viewWith(
      installed: string | null,
      options: { runtimeVersion?: string } = {}
    ): RuntimeLifecycleView {
      if (installed === null) return { ...VIEW, stale: false, stagedRuntime: STAGED };
      return {
        ...VIEW,
        stale: false,
        stagedRuntime: STAGED,
        health: {
          schemaVersion: 1,
          slot: 'wsl',
          source: 'provisioned',
          runtimeVersion: options.runtimeVersion ?? installed,
          version: installed,
          binaryPath: '/home/test/.mango/runtime/wsl/current/mangostudio-runtime',
          digest: `sha256:${'a'.repeat(64)}`,
          platformId: 'linux-x64',
          profile: 'full',
          allow: {
            fsRead: true,
            fsWrite: true,
            shell: true,
            git: true,
            probing: true,
            mcp: true,
            library: true,
            checkpoints: true,
            update: true,
            externalAgents: true,
          },
          setup: { state: 'configured' },
          platform: 'linux',
          arch: 'x64',
          homeDir: '/home/test',
          shells: ['bash'],
          git: { available: true, version: '2.51.0' },
          lastError: null,
          audit: { enabled: false },
        },
      };
    }

    it('says so when the machine already runs the offered build', async () => {
      const environment: Environment = { ...WSL, id: 'offer-matching' };
      scenario
        .respondWithJson('GET', '/api/environments/offer-matching/runtime', {
          body: viewWith('9.9.9'),
        })
        .install();
      render(<RuntimeLifecyclePanel environment={environment} />);

      expect(await screen.findByTestId('runtime-offer-matched')).toHaveTextContent(
        formatMessage(labels.staged.matched, { version: '9.9.9' })
      );
      expect(screen.queryByTestId('runtime-offer')).not.toBeInTheDocument();
      // The actions stay: a reinstall is still a thing to want.
      expect(screen.getByRole('button', { name: labels.actions.reinstall })).toBeInTheDocument();
    });

    it.each([
      ['a machine on a different build', '9.9.8', false, undefined],
      ['a machine that has never reported one', null, false, undefined],
      ['matching health that is stale', '9.9.9', true, undefined],
      ['a slot that was updated while this process still needs a restart', '9.9.9', false, '9.9.8'],
    ] as const)(
      'keeps offering the install for %s',
      async (_case, installed, stale, runtimeVersion) => {
        const environment: Environment = {
          ...WSL,
          id: `offer-${installed ?? 'none'}-${String(stale)}`,
        };
        scenario
          .respondWithJson('GET', `/api/environments/${environment.id}/runtime`, {
            body: { ...viewWith(installed, { runtimeVersion }), stale },
          })
          .install();
        render(<RuntimeLifecyclePanel environment={environment} />);

        expect(await screen.findByTestId('runtime-offer')).toHaveTextContent(
          formatMessage(labels.staged.offer, { version: '9.9.9', platform: 'linux-x64' })
        );
        expect(screen.queryByTestId('runtime-offer-matched')).not.toBeInTheDocument();
      }
    );
  });
});
