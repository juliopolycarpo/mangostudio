import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';

import { render, screen, within } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';
import { routerWithLinkStub } from '../../support/mocks/router';

void mock.module('@tanstack/react-router', await routerWithLinkStub());
const appState = { currentEnvironmentId: null };
void mock.module('@/lib/app-context', () => ({ useApp: () => appState }));

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
    expect(within(pill).getByText('Unconfirmed')).toHaveClass('bg-warning-subtle');
    expect(pill.querySelector('.truncate')).toBeNull();
    expect(pill.textContent).not.toContain('undefined');
  });

  it('says in words why an agent is unusable and keeps its identity colour', async () => {
    const MISSING: ExternalAgentDescriptor = {
      ...UNDETERMINED,
      targetId: 'codex',
      installed: false,
      discoveryState: 'determined',
      authState: 'unknown',
    };
    const SIGNED_OUT: ExternalAgentDescriptor = {
      ...UNDETERMINED,
      targetId: 'cursor',
      discoveryState: 'determined',
      authState: 'signed-out',
    };
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { environmentId: 'local', agents: [MISSING, SIGNED_OUT] },
    });
    render(<AgentsCard environmentId="local" />);
    const pills = await screen.findAllByTestId('hub-agent-pill');
    const [missing, signedOut] = pills;
    expect(within(missing as HTMLElement).getByText('Not installed')).toBeInTheDocument();
    expect(missing?.querySelector('[data-tone]')).toHaveClass('bg-agent-codex');
    expect(within(signedOut as HTMLElement).getByText('Signed out')).toBeInTheDocument();
    expect(signedOut?.querySelector('[data-tone]')).toHaveClass('bg-agent-cursor');
    // The full sentence stays where a row can hold it.
    expect(missing).toHaveAttribute('title', 'Not installed on this machine');
  });

  it('keeps red for a fault: an absent CLI is a neutral fact and a sign-in is a warning', async () => {
    const MISSING: ExternalAgentDescriptor = {
      ...UNDETERMINED,
      targetId: 'codex',
      installed: false,
      discoveryState: 'determined',
      authState: 'unknown',
    };
    const SIGNED_OUT: ExternalAgentDescriptor = {
      ...UNDETERMINED,
      targetId: 'cursor',
      discoveryState: 'determined',
      authState: 'signed-out',
    };
    const NEEDS_APPROVAL: ExternalAgentDescriptor = {
      ...UNDETERMINED,
      targetId: 'claude',
      discoveryState: 'determined',
      unavailableReason: 'disclosure-required',
    };
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { environmentId: 'local', agents: [MISSING, SIGNED_OUT, NEEDS_APPROVAL] },
    });
    render(<AgentsCard environmentId="local" />);
    const [missing, signedOut, needsApproval] = (await screen.findAllByTestId(
      'hub-agent-pill'
    )) as [HTMLElement, HTMLElement, HTMLElement];

    expect(missing).toHaveAttribute('data-availability', 'neutral');
    expect(within(missing).getByText('Not installed')).toHaveClass('bg-fill-selected');
    expect(signedOut).toHaveAttribute('data-availability', 'warning');
    expect(within(signedOut).getByText('Signed out')).toHaveClass('bg-warning-subtle');
    expect(needsApproval).toHaveAttribute('data-availability', 'warning');
    expect(within(needsApproval).getByText('Needs approval')).toHaveClass('bg-warning-subtle');
    // The word and the pill carry the state: no status glyph, and no row of
    // red error marks on an account that is merely missing optional CLIs.
    for (const row of [missing, signedOut, needsApproval]) {
      expect(row.querySelector('svg')).toBeNull();
      expect(row.querySelector('.text-danger, .bg-danger-subtle')).toBeNull();
    }
  });

  it('reserves the error badge for an agent that cannot run for a reason the person cannot clear', async () => {
    const UNREACHABLE: ExternalAgentDescriptor = {
      ...UNDETERMINED,
      targetId: 'codex',
      installed: false,
      discoveryState: 'determined',
      authState: 'unknown',
      unavailableReason: 'environment-unreachable',
    };
    const READY: ExternalAgentDescriptor = {
      ...UNDETERMINED,
      targetId: 'claude',
      discoveryState: 'determined',
      authState: 'signed-in',
    };
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { environmentId: 'local', agents: [UNREACHABLE, READY] },
    });
    render(<AgentsCard environmentId="local" />);
    const [unreachable, ready] = (await screen.findAllByTestId('hub-agent-pill')) as [
      HTMLElement,
      HTMLElement,
    ];

    // The stated reason wins over the inference from `installed`: nothing
    // could be asked of the machine, so "Not installed" would be a guess.
    expect(unreachable).toHaveAttribute('data-availability', 'error');
    expect(within(unreachable).getByText('Unavailable')).toHaveClass('bg-danger-subtle');
    expect(unreachable).toHaveAttribute('title', 'Could not reach this machine');
    expect(ready).toHaveAttribute('data-availability', 'success');
    expect(within(ready).getByText('Ready')).toHaveClass('bg-success-subtle');
  });

  it('drops a version parenthetical that only repeats the agent name', async () => {
    const claude: ExternalAgentDescriptor = {
      ...UNDETERMINED,
      discoveryState: 'determined',
      version: '2.1.305 (Claude Code)',
    };
    const codex: ExternalAgentDescriptor = {
      ...UNDETERMINED,
      targetId: 'codex',
      discoveryState: 'determined',
      version: '1.2.3 (beta)',
    };
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { environmentId: 'local', agents: [claude, codex] },
    });
    render(<AgentsCard environmentId="local" />);
    const [first, second] = await screen.findAllByTestId('hub-agent-pill');
    expect(first?.textContent).toContain('2.1.305');
    expect(first?.textContent).not.toContain('(Claude Code)');
    expect(second?.textContent).toContain('1.2.3 (beta)');
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
