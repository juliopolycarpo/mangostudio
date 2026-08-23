import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '../../../support/harness/render';
import { routerWithLinkStub } from '../../../support/mocks/router';

mock.module('@tanstack/react-router', await routerWithLinkStub());

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

  it('opens the umbrella root as its own tab, leaving the deeper ones alone', async () => {
    const { EnvironmentTabs } = await import(
      '../../../../src/features/environments/components/EnvironmentTabs'
    );

    render(<EnvironmentTabs />);

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/environments');
    // Every pre-existing tab keeps the URL it had: the overview is a new landing
    // page, not a reshuffle of the ones people already bookmarked.
    expect(screen.getByRole('link', { name: 'Toolchains' })).toHaveAttribute(
      'href',
      '/environments/runtimes'
    );
    expect(screen.getByRole('link', { name: 'Health' })).toHaveAttribute(
      'href',
      '/environments/health'
    );
  });
});
