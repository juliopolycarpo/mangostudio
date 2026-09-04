/**
 * The Runtimes screen folds every version manager's Node table into the Node
 * card, not just nvm — an fnm status has to render exactly like an nvm one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Environment } from '@mangostudio/shared/environments';
import { RuntimesPage } from '../../../../src/features/environments/components/RuntimesPage';
import { screen, waitFor, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { installRecipe, runtimeStatus, versionManagerStatus } from './fixtures';

const scenario = createFetchScenario();

const LOCAL_ENVIRONMENT: Environment = {
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
};

const RUNTIMES = [runtimeStatus({ id: 'node' })];

const VERSION_MANAGERS = [versionManagerStatus({ id: 'nvm' }), versionManagerStatus({ id: 'fnm' })];

/**
 * A catalog that can put Node under either manager, but cannot install either
 * manager itself — so an absent one has no chain that ends `ready`. A
 * *non-empty* catalog matters: an empty one reads as "still loading" and the
 * page keeps every manager.
 */
const RECIPES = (['nvm', 'fnm'] as const).map((manager) =>
  installRecipe({
    id: `${manager}.node.install`,
    runtimeId: 'node',
    action: 'use-version',
    inputKind: 'node-version',
    requires: [manager],
    missingRequirements: [manager],
  })
);

function installRuntimesScenario(versionManagers = VERSION_MANAGERS) {
  scenario
    .respondWithJson('GET', '/api/tool-identities', { body: { identities: {} } })
    .respondWithJson('GET', '/api/environments', { body: [LOCAL_ENVIRONMENT] })
    .respondWithJson('GET', '/api/environments/runtimes', { body: RUNTIMES })
    .respondWithJson('GET', '/api/environments/version-managers', { body: versionManagers })
    .respondWithJson('GET', '/api/environments/install/recipes', { body: RECIPES })
    .install();
}

beforeEach(() => {
  scenario.install();
});

afterEach(() => {
  scenario.restore();
});

describe('RuntimesPage', () => {
  it('folds every version manager into the Node card, not only nvm', async () => {
    installRuntimesScenario();

    await renderWithRouter(<RuntimesPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId('node-version-table')).toHaveLength(2);
    });
    const tables = screen.getAllByTestId('node-version-table');
    expect(within(tables[0] as HTMLElement).getByText('Managed by nvm')).toBeInTheDocument();
    expect(within(tables[1] as HTMLElement).getByText('Managed by fnm')).toBeInTheDocument();
  });

  // Regression: every detected manager used to get a table, so a machine with
  // neither installed and no recipe that could install one grew two dead
  // "not installed" blocks inside the Node card.
  it('omits an absent manager the catalog offers no way to install', async () => {
    installRuntimesScenario([
      versionManagerStatus({ id: 'nvm', installed: false }),
      versionManagerStatus({ id: 'fnm', installed: false }),
    ]);

    await renderWithRouter(<RuntimesPage />);

    await waitFor(() => {
      expect(screen.getByTestId('runtime-card')).toBeInTheDocument();
    });
    expect(screen.queryAllByTestId('node-version-table')).toHaveLength(0);
  });
});
