/**
 * InstallAction: a guard-blocked recipe degrades to a copyable command and
 * never issues an install request.
 */

import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallAction } from '../../../../src/features/environments/components/InstallAction';
import { render, screen } from '../../../support/harness/render';
import { installRecipe } from './fixtures';

describe('InstallAction', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders the copyable command and issues no request when a guard refuses', async () => {
    const recipe = installRecipe({
      guard: { allowed: false, reasons: ['server-not-loopback'] },
    });

    render(<InstallAction recipe={recipe} input={{ kind: 'none' }} label="Install Bun" />);
    await userEvent.click(screen.getByRole('button', { name: 'Install Bun' }));

    const block = screen.getByTestId('copy-command-block');
    expect(block.textContent).toContain(recipe.copyCommand);
    expect(block.textContent).toContain(
      en.environments.install.guardBlocked['server-not-loopback']
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains a missing requirement instead of firing a doomed request', async () => {
    const recipe = installRecipe({
      id: 'nvm.node.install',
      runtimeId: 'node',
      requires: ['nvm'],
      missingRequirements: ['nvm'],
      copyCommand: 'nvm install --lts',
    });

    render(<InstallAction recipe={recipe} input={{ kind: 'none' }} label="Install LTS" />);
    await userEvent.click(screen.getByRole('button', { name: 'Install LTS' }));

    expect(screen.getByTestId('copy-command-block').textContent).toContain('Install first: nvm');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders nothing when the server never offered the recipe', () => {
    render(<InstallAction recipe={undefined} input={{ kind: 'none' }} label="Install Bun" />);

    expect(screen.queryByRole('button', { name: 'Install Bun' })).not.toBeInTheDocument();
  });
});
