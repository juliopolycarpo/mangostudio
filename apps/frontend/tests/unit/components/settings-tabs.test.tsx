import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '../../support/harness/render';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { readonly to: string; readonly children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

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
