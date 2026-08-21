import { describe, expect, it, mock } from 'bun:test';
import type { ReactNode } from 'react';
import { render, screen } from '../../support/harness/render';

// Declared at module level rather than inline in the factory: biome's
// `noComponentHookFactories` rejects a component defined inside a function.
function LinkStub({ to, children }: { readonly to: string; readonly children: ReactNode }) {
  return <a href={to}>{children}</a>;
}

mock.module('@tanstack/react-router', () => ({ Link: LinkStub }));

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
