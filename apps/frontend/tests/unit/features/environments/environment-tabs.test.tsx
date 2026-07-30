import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '../../../support/harness/render';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { readonly to: string; readonly children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

describe('EnvironmentTabs', () => {
  it('carries the library as a tab of the umbrella', async () => {
    const { EnvironmentTabs } = await import(
      '../../../../src/features/environments/components/EnvironmentTabs'
    );

    render(<EnvironmentTabs />);

    // The library section owns a second tab strip, so the umbrella tab points at
    // the section root and lets that strip resolve which page opens.
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute(
      'href',
      '/environments/library'
    );
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute(
      'href',
      '/environments/agents'
    );
  });
});
