import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '../../support/harness/render';
import { routerWithLinkStub } from '../../support/mocks/router';

mock.module('@tanstack/react-router', await routerWithLinkStub());

describe('SettingsTabs', () => {
  it('includes the Agents, Git, and External API settings tabs', async () => {
    const { SettingsTabs } = await import('../../../src/components/settings/SettingsTabs');

    render(<SettingsTabs />);

    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute(
      'href',
      '/settings/agents'
    );
    expect(screen.getByRole('link', { name: 'Git' })).toHaveAttribute('href', '/settings/git');
    expect(screen.getByRole('link', { name: 'External API' })).toHaveAttribute(
      'href',
      '/settings/external-api'
    );
  });
});
