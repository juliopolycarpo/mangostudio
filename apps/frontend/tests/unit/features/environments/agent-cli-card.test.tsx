/**
 * AgentCliCard: an unknown auth signal is its own state and must never be
 * reported as signed out.
 */

import { en } from '@mangostudio/shared/i18n';
import { describe, expect, it } from 'vitest';
import { AgentCliCard } from '../../../../src/features/environments/components/AgentCliCard';
import { render, screen } from '../../../support/harness/render';
import { agentCliStatus, installation } from './fixtures';

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

  it('lists library locations with their writability', () => {
    const status = agentCliStatus({
      locations: [
        {
          id: 'claude-skills',
          kind: 'skill',
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
