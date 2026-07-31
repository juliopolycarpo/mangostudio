/**
 * The overview is four summaries of four tabs, each reading its own queries.
 *
 * That independence is the whole design, so it is what these assert: the four
 * sections arrive from the real query layer, the health numbers match what the
 * cards themselves would say, and a section whose data never loads costs
 * exactly its own block.
 */

import { en } from '@mangostudio/shared/i18n';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OverviewPage } from '../../../../src/features/environments/components/OverviewPage';
import { screen, waitFor, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { fullCoverage, instance, resource, TARGETS } from '../library/fixtures';
import { agentCliStatus, installation, runtimeStatus } from './fixtures';

const scenario = createFetchScenario();

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
  it('summarizes all four tabs on the landing page', async () => {
    installOverviewScenario();

    await renderWithRouter(<OverviewPage />);

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

  it('costs one section, not the page, when a query fails', async () => {
    // Every request but the library's resource scan, which is left unhandled.
    scenario
      .respondWithJson('GET', '/api/tool-identities', { body: { identities: {} } })
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
