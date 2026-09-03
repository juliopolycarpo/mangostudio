/**
 * AgentCliCard: an unknown auth signal is its own state and must never be
 * reported as signed out.
 */

import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { AgentCliCard } from '../../../../src/features/environments/components/AgentCliCard';
import { render, screen } from '../../../support/harness/render';
import { agentCliStatus, installation, installRecipe } from './fixtures';

describe('AgentCliCard', () => {
  it('never renders the signed-out string for an unknown auth signal', () => {
    const status = agentCliStatus({
      authSignal: 'unknown',
      authenticated: false,
      installations: [installation({ path: '/usr/local/bin/claude', version: '2.1.220' })],
      effective: installation({ path: '/usr/local/bin/claude', version: '2.1.220' }),
    });

    render(<AgentCliCard status={status} recipes={[]} />);

    expect(screen.getByText(en.environments.agents.authUnknown)).toBeInTheDocument();
    expect(screen.queryByText(en.environments.agents.authSignedOut)).not.toBeInTheDocument();
    expect(screen.getByTestId('auth-state')).toHaveAttribute('data-auth-signal', 'unknown');
  });

  it('reports a real signed-out verdict when the probe can see it', () => {
    const status = agentCliStatus({
      targetId: 'codex',
      id: 'codex',
      authSignal: 'file-absent',
      authenticated: false,
    });

    render(<AgentCliCard status={status} recipes={[]} />);

    expect(screen.getByText(en.environments.agents.authSignedOut)).toBeInTheDocument();
  });

  it('offers Update and Uninstall, after each other, once the CLI is installed', () => {
    const status = agentCliStatus({
      targetId: 'claude',
      id: 'claude',
      installations: [installation({ path: '/usr/local/bin/claude', version: '2.1.220' })],
      effective: installation({ path: '/usr/local/bin/claude', version: '2.1.220' }),
    });

    render(
      <AgentCliCard
        status={status}
        recipes={[
          installRecipe({ id: 'claude.update', runtimeId: 'claude', action: 'update' }),
          installRecipe({ id: 'claude.uninstall', runtimeId: 'claude', action: 'uninstall' }),
        ]}
      />
    );

    const update = screen.getByRole('button', {
      name: en.environments.runtimes.update.replace('{runtime}', 'Claude Code'),
    });
    const uninstall = screen.getByRole('button', {
      name: en.environments.runtimes.uninstall.replace('{runtime}', 'Claude Code'),
    });
    expect(update).toBeInTheDocument();
    expect(
      update.compareDocumentPosition(uninstall) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('renders a copy-only uninstall for a CLI whose vendor never documented one', () => {
    const status = agentCliStatus({
      targetId: 'codex',
      id: 'codex',
      installations: [installation({ path: '/usr/local/bin/codex', version: '1.0.0' })],
      effective: installation({ path: '/usr/local/bin/codex', version: '1.0.0' }),
    });

    render(
      <AgentCliCard
        status={status}
        recipes={[
          installRecipe({
            id: 'codex.uninstall',
            runtimeId: 'codex',
            action: 'uninstall',
            runnable: false,
            unrunnableReason: 'vendor-undocumented',
            copyCommand: 'rm -f ~/.local/bin/codex && rm -rf ~/.codex/packages/standalone',
          }),
        ]}
      />
    );

    expect(
      screen.getByText(en.environments.install.unrunnable['vendor-undocumented'])
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: en.environments.runtimes.uninstall.replace('{runtime}', 'Codex'),
      })
    ).not.toBeInTheDocument();
  });

  it('lists library locations with their writability', () => {
    const status = agentCliStatus({
      locations: [
        {
          id: 'claude-skills',
          kind: 'skill',
          scope: 'home',
          path: '/home/dev/.claude/skills',
          access: 'read-write',
          exists: true,
          readable: true,
          writable: false,
          targetIds: ['claude'],
          entryCount: 4,
        },
      ],
    });

    render(<AgentCliCard status={status} recipes={[]} />);

    const location = screen.getByTestId('library-location');
    expect(location.textContent).toContain('/home/dev/.claude/skills');
    expect(location.textContent).toContain(en.environments.agents.locationReadOnly);
    expect(location.textContent).toContain('4 entries');
  });
});
