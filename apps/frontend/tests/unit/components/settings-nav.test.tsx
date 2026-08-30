/**
 * The settings surface's navigation, in one place.
 *
 * "Is my page in the nav?" used to be asserted at the tail of whichever test
 * file happened to cover that page — four copies of the same question, none of
 * which could notice a page nobody wrote a settings test for. The whole list
 * is checked here instead, against the same model the command palette reads.
 */

import { describe, expect, it, mock } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { fireEvent, screen, within } from '@testing-library/react';
import { render } from '../../support/harness/render';
import { routerWithLinkStub } from '../../support/mocks/router';

/**
 * The real hook runs the caller's `select` over router state; a stub that
 * returns the whole state hands the component an object where it expects a
 * pathname.
 */
const routerState = { location: { pathname: '/settings/metrics' } };

mock.module(
  '@tanstack/react-router',
  await routerWithLinkStub({
    useRouterState: ({ select }: { select: (state: typeof routerState) => unknown }) =>
      select(routerState),
  })
);

const { SettingsNav } = await import('../../../src/components/settings/SettingsNav');
const { settingsNavGroups } = await import('../../../src/components/settings/settings-nav');

/** Every settings page, as `[group heading, link label, href]`. */
const PAGES: ReadonlyArray<readonly [string, string, string]> = [
  ['General', 'General', '/settings/general'],
  ['General', 'Appearance', '/settings/appearance'],
  ['Models & providers', 'Providers', '/settings/providers'],
  ['Models & providers', 'Connectors', '/settings/connectors'],
  ['Models & providers', 'Prompts', '/settings/prompts'],
  ['Models & providers', 'Context', '/settings/context'],
  ['Agents & tools', 'Agents', '/settings/agents'],
  ['Agents & tools', 'External agents', '/settings/external-agents'],
  ['Agents & tools', 'Skills', '/settings/skills'],
  ['Agents & tools', 'Tools', '/settings/tools'],
  ['Integrations', 'MCP', '/settings/mcp'],
  ['Integrations', 'Git', '/settings/git'],
  ['Integrations', 'External API', '/settings/external-api'],
  ['Observability', 'Metrics', '/settings/metrics'],
  ['Observability', 'Logs', '/settings/logs'],
];

describe('SettingsNav', () => {
  it.each(PAGES)('files %s › %s under its heading', (group, label, href) => {
    render(<SettingsNav />);

    const heading = screen.getByRole('heading', { name: group });
    const link = within(heading.parentElement as HTMLElement).getByRole('link', { name: label });

    expect(link).toHaveAttribute('href', href);
  });

  it('lists every settings page exactly once', () => {
    render(<SettingsNav />);

    expect(screen.getAllByRole('link')).toHaveLength(PAGES.length);
  });

  it('names the surface for a screen reader', () => {
    render(<SettingsNav />);

    expect(screen.getByRole('navigation')).toHaveAccessibleName(en.common.settingsNavigation);
  });

  it('stands in for the current page while collapsed, and expands on demand', () => {
    render(<SettingsNav />);

    // The pathname the router stub reports.
    const toggle = screen.getByRole('button', { name: 'Metrics' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('settingsNavGroups', () => {
  it('is the model the nav and the palette both read', () => {
    const flattened = settingsNavGroups(en.settings).flatMap((group) =>
      group.entries.map((entry) => [group.label, entry.label, String(entry.to)])
    );

    expect(flattened).toEqual(PAGES.map(([group, label, to]) => [group, label, to]));
  });

  it('gives every heading more than one page to hold', () => {
    for (const group of settingsNavGroups(en.settings)) {
      expect(group.entries.length).toBeGreaterThan(1);
    }
  });
});
