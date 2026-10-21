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
  it('puts what blocks something apart from what is only worth knowing', async () => {
    installHealthScenario();

    await renderWithRouter(<HealthPage />);

    await waitFor(() => expect(screen.getAllByTestId('health-list')).toHaveLength(2));
    const [needsAction, informational] = screen.getAllByTestId('health-list');
    expect(screen.getByRole('heading', { name: labels.health.needsAction })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: labels.health.forInformation })).toBeInTheDocument();
    // Nothing here is a warning, so the group for warnings is not drawn at all.
    expect(screen.queryByRole('heading', { name: labels.health.canWait })).toBeNull();
    // Only the missing Git is a failure; the optional absences sit below it.
    expect(within(needsAction as HTMLElement).getAllByTestId('health-entry')).toHaveLength(1);
    expect(within(needsAction as HTMLElement).getByTestId('health-entry')).toHaveAttribute(
      'data-severity',
      'fail'
    );
    for (const entry of within(informational as HTMLElement).getAllByTestId('health-entry')) {
      expect(entry).toHaveAttribute('data-severity', 'warn');
    }
    // Something does need action, so the page does not claim otherwise.
    expect(screen.queryByTestId('health-nothing-needs-action')).toBeNull();
  });

  // An optional tool that is not there is neutral, not a warning: the triangle
  // asks for something to be done, and there is nothing to do about a Codex the
  // person never installed.
  it('draws informational findings with the neutral ring, and what blocks with the alert', async () => {
    installHealthScenario();

    await renderWithRouter(<HealthPage />);

    await waitFor(() => expect(screen.getAllByTestId('health-list')).toHaveLength(2));
    const [needsAction, informational] = screen.getAllByTestId('health-list') as HTMLElement[];
    expect(needsAction.querySelector('.lucide-circle-alert')).not.toBeNull();
    expect(informational.querySelector('.lucide-triangle-alert')).toBeNull();
    expect(informational.querySelectorAll('.lucide-circle-dashed')).toHaveLength(2);
  });

  it('keeps warnings between what needs action and what is informational', async () => {
    scenario
      .respondWithJson('GET', '/api/tool-identities', { body: { identities: {} } })
      .respondWithJson('GET', '/api/environments', { body: [LOCAL] })
      .respondWithJson('GET', '/api/environments/runtimes', {
        body: [
          runtimeStatus({
            id: 'node',
            health: 'warn',
            findings: [{ code: 'multiple-versions', params: { runtime: 'node' } }],
          }),
        ],
      })
      .respondWithJson('GET', '/api/environments/version-managers', { body: [] })
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

    await renderWithRouter(<HealthPage />);

    await waitFor(() => expect(screen.getAllByTestId('health-list')).toHaveLength(2));
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings.indexOf(labels.health.canWait)).toBeLessThan(
      headings.indexOf(labels.health.forInformation)
    );
    expect(screen.queryByTestId('health-nothing-needs-action')).toBeNull();
  });

  // Absent optional tools are still listed, so the page is not empty: it says
  // in one line that nothing needs action and lists them below.
  it('says nothing needs action above a list of informational findings', async () => {
    scenario
      .respondWithJson('GET', '/api/tool-identities', { body: { identities: {} } })
      .respondWithJson('GET', '/api/environments', { body: [LOCAL] })
      .respondWithJson('GET', '/api/environments/runtimes', { body: [runtimeStatus()] })
      .respondWithJson('GET', '/api/environments/version-managers', {
        body: [
          versionManagerStatus({
            id: 'fnm',
            installed: false,
            findings: [{ code: 'not-found', params: { manager: 'fnm' }, severity: 'info' }],
          }),
        ],
      })
      .respondWithJson('GET', '/api/environments/agents', { body: [] })
      .install();

    await renderWithRouter(<HealthPage />);

    expect(await screen.findByTestId('health-nothing-needs-action')).toHaveTextContent(
      labels.health.nothingNeedsAction
    );
    expect(screen.getAllByTestId('health-list')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: labels.health.forInformation })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: labels.health.needsAction })).toBeNull();
    expect(screen.queryByText(labels.health.empty)).toBeNull();
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
