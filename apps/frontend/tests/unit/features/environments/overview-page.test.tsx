/**
 * The overview combines environment entities with summaries of the diagnostic tabs.
 *
 * That independence is the whole design, so it is what these assert: the
 * sections arrive from the real query layer, the health numbers match what the
 * cards themselves would say, and a section whose data never loads costs
 * exactly its own block.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OverviewPage } from '../../../../src/features/environments/components/OverviewPage';
import { screen, waitFor, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { fullCoverage, instance, resource, TARGETS } from '../library/fixtures';
import { agentCliStatus, installation, runtimeStatus } from './fixtures';

const scenario = createFetchScenario();

const ENVIRONMENTS: Environment[] = [
  {
    id: 'local',
    name: 'Local',
    transportKind: 'in-process',
    config: {},
    enabled: true,
    allowInstalls: false,
    virtual: true,
    createdAt: null,
    updatedAt: null,
    status: {
      state: 'connected',
      manifest: {
        platform: 'linux',
        arch: 'x64',
        pathStyle: 'posix',
        homeDir: '/home/dev',
        shells: ['bash'],
        git: { available: true, version: '2.47.0' },
        features: {
          tools: true,
          git: true,
          probing: true,
          mcp: true,
          library: true,
          checkpoints: true,
        },
      },
    },
  },
  {
    id: 'remote-dev',
    name: 'Remote dev',
    transportKind: 'stdio',
    config: {},
    enabled: true,
    allowInstalls: false,
    virtual: false,
    createdAt: 1,
    updatedAt: 1,
    status: { state: 'disconnected' },
  },
];

const AGENTS = [
  agentCliStatus({
    targetId: 'claude',
    id: 'claude',
    health: 'ok',
    authSignal: 'file-present',
    authenticated: true,
    installations: [installation({ path: '/usr/local/bin/claude', version: '2.1.220' })],
    effective: installation({ path: '/usr/local/bin/claude', version: '2.1.220' }),
  }),
  agentCliStatus({
    targetId: 'codex',
    id: 'codex',
    health: 'missing',
    findings: [{ code: 'cli-not-installed', params: { targetId: 'codex' } }],
  }),
];

const RUNTIMES = [
  runtimeStatus({
    id: 'bun',
    health: 'ok',
    installations: [installation({ path: '/home/dev/.bun/bin/bun', version: '1.3.14' })],
    effective: installation({ path: '/home/dev/.bun/bin/bun', version: '1.3.14' }),
  }),
  // The 002 case: found on disk, unreachable from a shell. It is a warning on
  // its card, so it has to be a warning in the rollup too.
  runtimeStatus({
    id: 'node',
    health: 'warn',
    installations: [
      installation({ path: '/opt/node/bin/node', version: '22.13.0', origin: 'well-known' }),
    ],
    findings: [
      {
        code: 'installed-but-not-on-path',
        params: { runtime: 'node', path: '/opt/node/bin/node' },
      },
    ],
  }),
];

/** One skill every target reads, at a version Cursor disagrees on. */
const RESOURCES = [
  resource({
    instances: [
      instance({ locationId: 'agents-skills', contentHash: 'aaa111' }),
      instance({ locationId: 'claude-skills', contentHash: 'aaa111' }),
      instance({ locationId: 'cursor-skills', contentHash: 'bbb222' }),
    ],
    coverage: fullCoverage({
      mangostudio: { state: 'present', effectiveLocationId: 'agents-skills' },
      claude: { state: 'present', effectiveLocationId: 'claude-skills' },
      codex: { state: 'present', effectiveLocationId: 'agents-skills' },
      cursor: { state: 'present', effectiveLocationId: 'cursor-skills' },
    }),
    divergence: 'divergent',
  }),
];

function installOverviewScenario() {
  scenario
    .respondWithJson('GET', '/api/tool-identities', { body: { identities: {} } })
    .respondWithJson('GET', '/api/environments', { body: ENVIRONMENTS })
    .respondWithJson('GET', '/api/environments/agents', { body: AGENTS })
    .respondWithJson('GET', '/api/environments/runtimes', { body: RUNTIMES })
    .respondWithJson('GET', '/api/environments/install/recipes', { body: [] })
    .respondWithJson('GET', '/api/library/resources', { body: RESOURCES })
    .respondWithJson('GET', '/api/library/targets', { body: TARGETS })
    .install();
}

beforeEach(() => {
  scenario.install();
});

afterEach(() => {
  scenario.restore();
});

describe('OverviewPage', () => {
  it('surfaces execution targets alongside the diagnostic summaries', async () => {
    installOverviewScenario();

    await renderWithRouter(<OverviewPage />);

    const environments = await screen.findByTestId('overview-environments');
    const cards = within(environments).getAllByTestId('environment-entity-card');
    const local = cards.find(
      (card) => card.getAttribute('data-environment-id') === 'local'
    ) as HTMLElement;
    const remote = cards.find(
      (card) => card.getAttribute('data-environment-id') === 'remote-dev'
    ) as HTMLElement;
    expect(local).toBeDefined();
    expect(remote).toBeDefined();
    expect(within(local).getByRole('heading', { name: 'Local' })).toBeInTheDocument();
    expect(within(local).getByText('Connected')).toBeInTheDocument();
    expect(within(local).getByText('Git 2.47.0')).toBeInTheDocument();
    expect(within(local).getByText('Checkpoints')).toBeInTheDocument();
    expect(within(remote).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(within(remote).getByRole('button', { name: 'Edit name' })).toBeInTheDocument();
    expect(within(remote).getByRole('button', { name: 'Remove' })).toBeInTheDocument();

    const agents = await screen.findByTestId('overview-agents');
    expect(within(agents).getAllByTestId('overview-agent-card')).toHaveLength(2);
    expect(within(agents).getByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();

    const toolchains = screen.getByTestId('overview-toolchains');
    await waitFor(() => {
      expect(within(toolchains).getAllByTestId('overview-toolchain-card')).toHaveLength(2);
    });
    // The effective binary's version, not the newest one installed.
    expect(within(toolchains).getByText('1.3.14')).toBeInTheDocument();

    const library = screen.getByTestId('overview-library');
    await waitFor(() => {
      expect(within(library).getAllByTestId('library-coverage-row')).toHaveLength(4);
    });

    // Every section links to the tab it summarizes, so the overview is a way in
    // rather than a dead end.
    expect(
      within(agents).getByRole('link', {
        name: en.environments.overview.open.replace('{section}', en.environments.tabs.agents),
      })
    ).toHaveAttribute('href', '/environments/agents');
  });

  it('shows a permissions row when the connected machine consents to readonly', async () => {
    const localBase = ENVIRONMENTS.find((environment) => environment.id === 'local');
    if (!localBase) throw new Error('expected local fixture');
    const readonlyLocal: Environment = {
      ...localBase,
      status: {
        state: 'connected',
        manifest: {
          platform: 'linux',
          arch: 'x64',
          pathStyle: 'posix',
          homeDir: '/home/dev',
          shells: [],
          git: { available: true, version: '2.47.0' },
          features: {
            tools: true,
            git: true,
            probing: false,
            mcp: false,
            library: false,
            checkpoints: true,
            fsRead: true,
            fsWrite: false,
            shell: false,
            update: false,
          },
          profile: 'readonly',
        },
      },
    };
    scenario
      .respondWithJson('GET', '/api/tool-identities', { body: { identities: {} } })
      .respondWithJson('GET', '/api/environments', { body: [readonlyLocal, ENVIRONMENTS[1]] })
      .respondWithJson('GET', '/api/environments/agents', { body: AGENTS })
      .respondWithJson('GET', '/api/environments/runtimes', { body: RUNTIMES })
      .respondWithJson('GET', '/api/environments/install/recipes', { body: [] })
      .respondWithJson('GET', '/api/library/resources', { body: RESOURCES })
      .respondWithJson('GET', '/api/library/targets', { body: TARGETS })
      .install();

    await renderWithRouter(<OverviewPage />);

    const local = await waitFor(() => {
      const card = screen
        .getAllByTestId('environment-entity-card')
        .find((candidate) => candidate.getAttribute('data-environment-id') === 'local');
      expect(card).toBeDefined();
      return card as HTMLElement;
    });

    const permissions = within(local).getByTestId('environment-permissions');
    expect(
      within(permissions).getByText(en.environments.entities.permissions.title)
    ).toBeInTheDocument();
    expect(
      within(permissions).getByText(en.environments.entities.permissions.profile.readonly)
    ).toBeInTheDocument();
    expect(within(permissions).getByText('fsWrite')).toBeInTheDocument();
    expect(within(permissions).getByText('shell')).toBeInTheDocument();
    expect(
      within(permissions).getByText('mangostudio-runtime setup --slot host')
    ).toBeInTheDocument();
    expect(
      within(permissions).getByText(en.environments.entities.permissions.allowShellHonesty)
    ).toBeInTheDocument();

    const remote = screen
      .getAllByTestId('environment-entity-card')
      .find(
        (candidate) => candidate.getAttribute('data-environment-id') === 'remote-dev'
      ) as HTMLElement;
    expect(within(remote).queryByTestId('environment-permissions')).not.toBeInTheDocument();
    expect(within(remote).getByText(en.environments.entities.noManifest)).toBeInTheDocument();
  });

  it('renames a persisted execution environment inline', async () => {
    const user = userEvent.setup();
    const renamed = {
      ...ENVIRONMENTS[1],
      name: 'Build host',
      updatedAt: 2,
    };
    installOverviewScenario();
    scenario.respondWithJson('PUT', '/api/environments/remote-dev', { body: renamed });

    await renderWithRouter(<OverviewPage />);

    const remote = await waitFor(() => {
      const card = screen
        .getAllByTestId('environment-entity-card')
        .find((candidate) => candidate.getAttribute('data-environment-id') === 'remote-dev');
      expect(card).toBeDefined();
      return card as HTMLElement;
    });
    await user.click(within(remote).getByRole('button', { name: 'Edit name' }));
    const input = within(remote).getByRole('textbox', { name: 'Environment name' });
    await user.clear(input);
    await user.type(input, 'Build host');
    await user.click(within(remote).getByRole('button', { name: 'Save' }));

    expect(await within(remote).findByRole('heading', { name: 'Build host' })).toBeInTheDocument();
  });

  it('commits an inline rename with Enter and abandons it with Escape', async () => {
    const user = userEvent.setup();
    installOverviewScenario();
    scenario.respondWithJson('PUT', '/api/environments/remote-dev', {
      body: { ...ENVIRONMENTS[1], name: 'Build host', updatedAt: 2 },
    });

    await renderWithRouter(<OverviewPage />);

    const remote = await waitFor(() => {
      const card = screen
        .getAllByTestId('environment-entity-card')
        .find((candidate) => candidate.getAttribute('data-environment-id') === 'remote-dev');
      expect(card).toBeDefined();
      return card as HTMLElement;
    });

    // Escape abandons the edit and restores the persisted name.
    await user.click(within(remote).getByRole('button', { name: 'Edit name' }));
    await user.clear(within(remote).getByRole('textbox', { name: 'Environment name' }));
    await user.type(within(remote).getByRole('textbox', { name: 'Environment name' }), 'Discarded');
    await user.keyboard('{Escape}');
    expect(
      await within(remote).findByRole('heading', { name: ENVIRONMENTS[1]?.name })
    ).toBeInTheDocument();

    // Enter saves without reaching for the mouse.
    await user.click(within(remote).getByRole('button', { name: 'Edit name' }));
    await user.clear(within(remote).getByRole('textbox', { name: 'Environment name' }));
    await user.type(
      within(remote).getByRole('textbox', { name: 'Environment name' }),
      'Build host{Enter}'
    );

    expect(await within(remote).findByRole('heading', { name: 'Build host' })).toBeInTheDocument();
  });

  it('counts a tool the shell cannot reach as needing attention', async () => {
    installOverviewScenario();

    await renderWithRouter(<OverviewPage />);

    const rollup = await screen.findByTestId('health-rollup');
    const countFor = (health: string) =>
      within(rollup).getByText(en.environments.status[health as 'ok']).previousElementSibling
        ?.textContent;

    // Two ok (Claude, Bun), one warn (Node found off PATH), one missing (Codex).
    await waitFor(() => expect(countFor('ok')).toBe('2'));
    expect(countFor('warn')).toBe('1');
    expect(countFor('missing')).toBe('1');
    expect(countFor('error')).toBe('0');
    expect(screen.queryByText(en.environments.overview.healthClear)).not.toBeInTheDocument();
  });

  it('reports the worst finding on the card of the agent it belongs to', async () => {
    installOverviewScenario();

    await renderWithRouter(<OverviewPage />);

    const codex = await waitFor(() => {
      const card = screen
        .getAllByTestId('overview-agent-card')
        .find((candidate) => candidate.getAttribute('data-target-id') === 'codex');
      expect(card).toBeDefined();
      return card as HTMLElement;
    });

    expect(within(codex).getByTestId('overview-agent-finding')).toHaveAttribute(
      'data-finding-code',
      'cli-not-installed'
    );
  });

  it('refuses to publish a health count drawn from only one of its two sources', async () => {
    // Every request but the agent probe, which is left unhandled. The rollup
    // spans runtimes and agents, so half of it is not a smaller truth — a
    // rollup that answered from runtimes alone would report every agent as
    // fine by never having asked.
    scenario
      .respondWithJson('GET', '/api/tool-identities', { body: { identities: {} } })
      .respondWithJson('GET', '/api/environments', { body: ENVIRONMENTS })
      .respondWithJson('GET', '/api/environments/runtimes', { body: RUNTIMES })
      .respondWithJson('GET', '/api/environments/install/recipes', { body: [] })
      .respondWithJson('GET', '/api/library/resources', { body: RESOURCES })
      .respondWithJson('GET', '/api/library/targets', { body: TARGETS })
      .install();

    await renderWithRouter(<OverviewPage />);

    const health = await screen.findByTestId('overview-health');
    await waitFor(() => {
      expect(within(health).getByTestId('environments-error')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('health-rollup')).not.toBeInTheDocument();
    expect(screen.queryByText(en.environments.overview.healthClear)).not.toBeInTheDocument();

    // The library numbers do not depend on an agent probe, so they still land.
    const library = screen.getByTestId('overview-library');
    await waitFor(() => {
      expect(within(library).getAllByTestId('library-coverage-row')).toHaveLength(4);
    });
  });

  it('costs one section, not the page, when a query fails', async () => {
    // Every request but the library's resource scan, which is left unhandled.
    scenario
      .respondWithJson('GET', '/api/tool-identities', { body: { identities: {} } })
      .respondWithJson('GET', '/api/environments', { body: ENVIRONMENTS })
      .respondWithJson('GET', '/api/environments/agents', { body: AGENTS })
      .respondWithJson('GET', '/api/environments/runtimes', { body: RUNTIMES })
      .respondWithJson('GET', '/api/environments/install/recipes', { body: [] })
      .respondWithJson('GET', '/api/library/targets', { body: TARGETS })
      .install();

    await renderWithRouter(<OverviewPage />);

    const library = await screen.findByTestId('overview-library');
    await waitFor(() => {
      expect(within(library).getByTestId('environments-error')).toBeInTheDocument();
    });

    // The other three sections are unaffected: a failed library scan says
    // nothing about which agents are installed.
    expect(screen.getAllByTestId('overview-agent-card')).toHaveLength(2);
    expect(screen.getByTestId('health-rollup')).toBeInTheDocument();
  });
});
