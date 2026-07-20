import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GitSettingsPage } from '@/features/settings/git';
import { render } from '../../support/harness/render';

describe('GitSettingsPage', () => {
  it('updates commit signing and sign-off preferences', async () => {
    const user = userEvent.setup();
    const setSignCommits = vi.fn();
    const setSignOff = vi.fn();

    render(
      <GitSettingsPage
        settings={{ signCommits: false, signOff: true }}
        setSignCommits={setSignCommits}
        setSignOff={setSignOff}
      />
    );

    expect(screen.getByText('Uses your Git config signing key — GPG or SSH.')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Sign commits' }));
    await user.click(screen.getByRole('checkbox', { name: 'Add Signed-off-by trailer' }));

    expect(setSignCommits).toHaveBeenCalledWith(true);
    expect(setSignOff).toHaveBeenCalledWith(false);
  });
});
