import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { render, screen, within } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';
import { routerWithLinkStub } from '../../support/mocks/router';

mock.module('@tanstack/react-router', await routerWithLinkStub());
const appState = { currentEnvironmentId: null };
mock.module('@/lib/app-context', () => ({ useApp: () => appState }));

import { AgentsCard } from '../../../src/features/home/widgets/AgentsCard';
import { ExternalAgentDiscoveryLog } from '../../../src/features/settings/observability/components/ExternalAgentDiscoveryLog';

const UNDETERMINED: ExternalAgentDescriptor = {
  targetId: 'claude',
  environmentId: 'local',
  installed: true,
  discoveryState: 'undetermined',
  authState: 'signed-in',
  capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
  supportedConfigurations: [],
  discovery: { source: 'live', probedAtMs: 1_790_000_000_000, attempts: 1 },
};

describe('discovery uncertainty outside the runner selector', () => {
  const scenario = createFetchScenario();

  beforeEach(() => scenario.install());
  afterEach(() => scenario.restore());

  it('shows an uncertain home target without creating an empty version label', async () => {
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { environmentId: 'local', agents: [UNDETERMINED] },
    });
    render(<AgentsCard environmentId="local" />);
    const pill = await screen.findByTestId('hub-agent-pill');
    expect(pill).toHaveAttribute('data-availability', 'warning');
    expect(pill).toHaveAttribute('title', 'availability undetermined');
    expect(within(pill).getByText('Claude Code')).toBeInTheDocument();
    expect(pill.querySelector('.truncate')).toBeNull();
    expect(pill.textContent).not.toContain('undefined');
  });

  it('explains a cut-off discovery in Settings and retains its probe diagnostics', async () => {
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { environmentId: 'local', agents: [UNDETERMINED] },
    });
    render(<ExternalAgentDiscoveryLog />);
    expect(await screen.findByText(/The probe could not confirm this agent/)).toBeInTheDocument();
    expect(screen.getByText(/You can still try a turn/)).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Probed')).toBeInTheDocument();
  });
});
