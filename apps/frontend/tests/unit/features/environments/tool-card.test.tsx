/**
 * The card anatomy every tool shares.
 *
 * Both cards are the same shell with a different body, so the things a caller
 * outside them depends on — the id hook each card is found by, and the overflow
 * menu that renames the tool — have to hold for either one.
 */

import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AgentCliCard } from '../../../../src/features/environments/components/AgentCliCard';
import { RuntimeCard } from '../../../../src/features/environments/components/RuntimeCard';
import { render, screen, within } from '../../../support/harness/render';
import { agentCliStatus, runtimeStatus } from './fixtures';

describe('tool card anatomy', () => {
  it('keeps the id hook each card is found by', () => {
    render(<RuntimeCard status={runtimeStatus({ id: 'bun' })} recipes={[]} />);
    render(<AgentCliCard status={agentCliStatus({ targetId: 'codex' })} recipes={[]} />);

    expect(screen.getByTestId('runtime-card')).toHaveAttribute('data-runtime-id', 'bun');
    expect(screen.getByTestId('agent-cli-card')).toHaveAttribute('data-target-id', 'codex');
  });

  it.each([
    ['runtime', () => <RuntimeCard status={runtimeStatus({ id: 'bun' })} recipes={[]} />, 'Bun'],
    ['agent', () => <AgentCliCard status={agentCliStatus()} recipes={[]} />, 'Claude Code'],
  ])('opens the identity dialog from the %s card overflow menu', async (_kind, card, name) => {
    render(card());

    await userEvent.click(screen.getByTestId('tool-identity-menu'));
    await userEvent.click(screen.getByRole('menuitem', { name: en.environments.identity.rename }));

    const dialog = screen.getByTestId('identity-edit-dialog');
    expect(within(dialog).getByRole('dialog')).toHaveAccessibleName(
      en.environments.identity.dialogTitle.replace('{name}', name)
    );
  });
});
