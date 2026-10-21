/**
 * The Health screen answers "what is wrong". It has to tell what blocks
 * something from what is merely absent, list one missing tool once, and open
 * the tab that can do something about it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Environment } from '@mangostudio/shared/environments';
import { en } from '@mangostudio/shared/i18n';
import { HealthPage } from '../../../../src/features/environments/components/HealthPage';
import { screen, waitFor, within } from '../../../support/harness/render';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { agentCliStatus, runtimeStatus, versionManagerStatus } from './fixtures';

const scenario = createFetchScenario();
const labels = en.environments;

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

/** Git missing blocks the setup; fnm and Codex are tools nobody requires. */
function installHealthScenario() {
  scenario
    .respondWithJson('GET', '/api/tool-identities', { body: { identities: {} } })
    .respondWithJson('GET', '/api/environments', { body: [LOCAL] })
    .respondWithJson('GET', '/api/environments/runtimes', {
      body: [
        runtimeStatus({
          id: 'git',
          health: 'missing',
          findings: [{ code: 'not-found', params: { runtime: 'git' } }],
        }),
        runtimeStatus({
          id: 'fnm',
          health: 'missing',
          findings: [{ code: 'not-found', params: { runtime: 'fnm' }, severity: 'info' }],
        }),
      ],
    })
    .respondWithJson('GET', '/api/environments/version-managers', {
      body: [
        versionManagerStatus({
          id: 'fnm',
          installed: false,
          findings: [{ code: 'not-found', params: { manager: 'fnm' }, severity: 'info' }],
        }),
      ],
    })
    .respondWithJson('GET', '/api/environments/agents', {
      body: [
        agentCliStatus({
          targetId: 'codex',
          health: 'missing',
          findings: [
            { code: 'cli-not-installed', params: { targetId: 'codex' }, severity: 'info' },
          ],
        }),
      ],
    })
    .install();
}

beforeEach(() => {
  scenario.install();
});

afterEach(() => {
  scenario.restore();
});

describe('HealthPage', () => {
  it('puts what blocks something apart from what can wait', async () => {
    installHealthScenario();

    await renderWithRouter(<HealthPage />);

    await waitFor(() => expect(screen.getAllByTestId('health-list')).toHaveLength(2));
    const [needsAction, canWait] = screen.getAllByTestId('health-list');
    expect(screen.getByRole('heading', { name: labels.health.needsAction })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: labels.health.canWait })).toBeInTheDocument();
    // Only the missing Git is a failure; the optional absences sit below it.
    expect(within(needsAction as HTMLElement).getAllByTestId('health-entry')).toHaveLength(1);
    expect(within(needsAction as HTMLElement).getByTestId('health-entry')).toHaveAttribute(
      'data-severity',
      'fail'
    );
    for (const entry of within(canWait as HTMLElement).getAllByTestId('health-entry')) {
      expect(entry).toHaveAttribute('data-severity', 'warn');
    }
  });

  // fnm is probed as a binary and as a version manager, and both raise the same
  // finding. One absent tool is one row.
  it('lists a tool the page probes twice once', async () => {
    installHealthScenario();

    await renderWithRouter(<HealthPage />);

    await waitFor(() => expect(screen.getAllByTestId('health-entry').length).toBeGreaterThan(0));
    const rows = screen.getAllByTestId('health-entry');
    // Git, fnm (as a version manager, once) and Codex.
    expect(rows).toHaveLength(3);
    expect(
      screen.getAllByText(new RegExp(`${labels.health.scope['version-manager']} · `))
    ).toHaveLength(1);
    expect(
      screen.queryByText(new RegExp(`${labels.health.scope.runtime} · .*fnm`, 'i'))
    ).toBeNull();
  });

  it('opens the tab that can act on each finding', async () => {
    installHealthScenario();

    await renderWithRouter(<HealthPage />);

    await waitFor(() => expect(screen.getAllByTestId('health-entry-link')).toHaveLength(3));
    const hrefs = screen
      .getAllByTestId('health-entry-link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs.filter((href) => href === '/environments/runtimes')).toHaveLength(2);
    expect(hrefs.filter((href) => href === '/environments/agents')).toHaveLength(1);
  });

  it('says nothing needs attention when every probe is clean', async () => {
    scenario
      .respondWithJson('GET', '/api/tool-identities', { body: { identities: {} } })
      .respondWithJson('GET', '/api/environments', { body: [LOCAL] })
      .respondWithJson('GET', '/api/environments/runtimes', { body: [runtimeStatus()] })
      .respondWithJson('GET', '/api/environments/version-managers', { body: [] })
      .respondWithJson('GET', '/api/environments/agents', { body: [] })
      .install();

    await renderWithRouter(<HealthPage />);

    expect(await screen.findByText(labels.health.empty)).toBeInTheDocument();
    expect(screen.queryByTestId('health-list')).toBeNull();
  });
});
