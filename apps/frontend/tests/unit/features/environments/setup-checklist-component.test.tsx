/**
 * SetupChecklist: each row renders its status badge and the one remedy
 * affordance that clears it — a button for an install chain, a link for
 * "go check that tab", nothing once the row is already done.
 */

import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { SetupChecklist } from '../../../../src/features/environments/components/SetupChecklist';
import { screen, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { agentCliStatus, installation, installRecipe, runtimeStatus } from './fixtures';

describe('SetupChecklist', () => {
  it('renders done, todo, and optional rows with the affordance each state needs', async () => {
    const runtimes = [
      runtimeStatus({
        id: 'git',
        installations: [installation({ path: '/usr/bin/git', version: '2.47.0', effective: true })],
      }),
      runtimeStatus({ id: 'node', installations: [] }),
      runtimeStatus({ id: 'bun', installations: [] }),
    ];
    const agents = [
      agentCliStatus({
        targetId: 'claude',
        id: 'claude',
        effective: installation({ path: '/usr/local/bin/claude', version: '2.1.220' }),
        authenticated: true,
      }),
    ];
    const recipes = [
      installRecipe({
        id: 'nvm.node.install',
        runtimeId: 'node',
        action: 'use-version',
        inputKind: 'node-version',
      }),
    ];

    await renderWithRouter(
      <SetupChecklist runtimes={runtimes} agents={agents} recipes={recipes} machine={undefined} />
    );

    const rows = screen.getAllByTestId('setup-row');
    const byId = (id: string) => rows.find((row) => row.getAttribute('data-setup-row') === id);

    const git = byId('git');
    if (!git) throw new Error('expected a git row');
    expect(git).toHaveAttribute('data-setup-status', 'done');
    expect(within(git).getByText(en.environments.overview.setup.status.done)).toBeInTheDocument();

    const node = byId('node');
    if (!node) throw new Error('expected a node row');
    expect(node).toHaveAttribute('data-setup-status', 'todo');
    expect(
      within(node).getByRole('button', {
        name: en.environments.runtimes.install.replace('{runtime}', 'Node.js'),
      })
    ).toBeInTheDocument();

    const bun = byId('bun');
    if (!bun) throw new Error('expected a bun row');
    expect(bun).toHaveAttribute('data-setup-status', 'optional');

    const agent = byId('agent');
    if (!agent) throw new Error('expected an agent row');
    expect(agent).toHaveAttribute('data-setup-status', 'done');

    const hubService = byId('hub-service');
    if (!hubService) throw new Error('expected a hub-service row');
    expect(hubService).toHaveAttribute('data-setup-status', 'todo');
    expect(
      within(hubService).getByRole('link', {
        name: en.environments.overview.open.replace('{section}', en.environments.tabs.machine),
      })
    ).toHaveAttribute('href', '/environments/machine');
  });
});
