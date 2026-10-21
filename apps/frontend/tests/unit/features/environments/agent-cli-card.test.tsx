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

  // Signed in is a status, so it is a badge beside "Available" in the header, not
  // bare green text on a line of its own; signed out is something the person can
  // fix, so it is a warning (as on Home), not a blue note.
  it('draws the sign-in state as a badge in the header: success, or a warning when it can be fixed', () => {
    const installed = {
      installations: [installation({ path: '/usr/local/bin/claude', version: '2.1.220' })],
      effective: installation({ path: '/usr/local/bin/claude', version: '2.1.220' }),
    };

    const { rerender } = render(
      <AgentCliCard
        status={agentCliStatus({
          ...installed,
          authSignal: 'file-present',
          authenticated: true,
        })}
        recipes={[]}
      />
    );
    const signedIn = screen.getByTestId('auth-state');
    expect(signedIn).toHaveTextContent(en.environments.agents.authSignedIn);
    expect(signedIn.className).toContain('bg-success-subtle');
    expect(signedIn.closest('header')).not.toBeNull();

    rerender(
      <AgentCliCard
        status={agentCliStatus({ ...installed, authSignal: 'file-absent', authenticated: false })}
        recipes={[]}
      />
    );
    expect(screen.getByTestId('auth-state').className).toContain('bg-warning-subtle');
  });

  // "Not signed in" is true of a CLI that is not there, and is no reason to ask for
  // anything: an absent optional tool is neutral.
  it('keeps the signed-out badge neutral when the CLI is not installed at all', () => {
    render(
      <AgentCliCard
        status={agentCliStatus({
          targetId: 'codex',
          id: 'codex',
          authSignal: 'file-absent',
          authenticated: false,
        })}
        recipes={[]}
      />
    );

    expect(screen.getByTestId('auth-state').className).toContain('bg-fill-selected');
    expect(screen.getByTestId('auth-state').className).not.toContain('bg-warning-subtle');
  });

  // Path, state and count are columns shared by every row, so "writable" starts at
  // one x on each of them instead of wherever the path before it happened to end.
  it('lays the library locations out as columns that every row shares', () => {
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
          writable: true,
          targetIds: ['claude'],
          entryCount: 4,
        },
        {
          id: 'claude-commands',
          kind: 'command',
          scope: 'home',
          path: '/home/dev/.claude/commands',
          access: 'read-write',
          exists: false,
          readable: false,
          writable: false,
          targetIds: ['claude'],
        },
      ],
    });

    render(<AgentCliCard status={status} recipes={[]} />);

    const rows = screen.getAllByTestId('library-location');
    expect(rows).toHaveLength(2);
    // Three cells per row whether or not there is a count, so the columns line up.
    for (const row of rows) expect(row.children).toHaveLength(3);
    expect(rows[0].parentElement?.className).toContain('grid-cols-[minmax(0,1fr)_auto_auto]');
    expect(rows[0].className).toContain('grid-cols-subgrid');
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
    // The vendor-owned path: `claude.uninstall` removes exactly this file, so
    // it is the installation the button is entitled to remove.
    const vendorPath = '/home/dev/.local/bin/claude';
    const status = agentCliStatus({
      targetId: 'claude',
      id: 'claude',
      installations: [installation({ path: vendorPath, version: '2.1.220' })],
      effective: installation({ path: vendorPath, version: '2.1.220' }),
    });

    render(
      <AgentCliCard
        status={status}
        recipes={[
          installRecipe({ id: 'claude.update', runtimeId: 'claude', action: 'update' }),
          installRecipe({
            id: 'claude.uninstall',
            runtimeId: 'claude',
            action: 'uninstall',
            writes: ['$HOME/.local/bin/claude', '%USERPROFILE%\\.local\\bin\\claude.exe'],
          }),
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

  // `claude.uninstall` removes `~/.local/bin/claude`. Against a CLI installed
  // by a package manager somewhere else it would leave the effective binary
  // running, and could delete a separate vendor install while reporting
  // success.
  it('offers no Uninstall when the effective CLI is not the one the recipe owns', () => {
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
          installRecipe({
            id: 'claude.uninstall',
            runtimeId: 'claude',
            action: 'uninstall',
            writes: ['$HOME/.local/bin/claude', '%USERPROFILE%\\.local\\bin\\claude.exe'],
          }),
        ]}
      />
    );

    expect(
      screen.queryByRole('button', {
        name: en.environments.runtimes.uninstall.replace('{runtime}', 'Claude Code'),
      })
    ).not.toBeInTheDocument();
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

describe('AgentCliCard footer', () => {
  it('closes on no footer at all when nothing installs the CLI here', () => {
    // The catalog is empty while it loads, and on a disconnected environment.
    // A `RecipeAction` that renders nothing is still a truthy element, so the
    // card has to decide on the step rather than on the rendered node — or it
    // opens a footer with a gap and no button in it.
    const status = agentCliStatus({ targetId: 'codex', id: 'codex' });

    const { container } = render(<AgentCliCard status={status} recipes={[]} />);

    expect(status.effective).toBeUndefined();
    expect(container.querySelector('footer')).toBeNull();
  });

  it('opens a footer once the catalog offers an install', () => {
    const status = agentCliStatus({ targetId: 'codex', id: 'codex' });

    const { container } = render(
      <AgentCliCard
        status={status}
        recipes={[installRecipe({ id: 'codex.install', runtimeId: 'codex', action: 'install' })]}
      />
    );

    expect(container.querySelector('footer')).not.toBeNull();
  });
});
