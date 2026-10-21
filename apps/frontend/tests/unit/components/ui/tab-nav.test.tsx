/**
 * `TabNav` is one row that scrolls, not a strip that wraps: a wrapped strip put
 * the current tab's rule on a row with no divider under it and pushed a phone's
 * page content below the fold. Because it scrolls, the current tab can be out of
 * view, so it has to be brought in.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TAB_CLASSES } from '@/components/ui/Tabs';
import { render } from '../../../support/harness/render';
import { LinkStub, routerWithLinkStub } from '../../../support/mocks/router';

/**
 * A link that, like the router's, marks the one that matches the current URL
 * `aria-current="page"` and dresses it in `activeProps`, every other one in
 * `inactiveProps`. The router adds its own `aria-current` only to a match, so a
 * tab forced current has to carry it in `inactiveProps`.
 */
function CurrentAwareLink({
  to,
  children,
  className,
  activeProps,
  inactiveProps,
  ...props
}: {
  to: string;
  children?: ReactNode;
  className?: string;
  activeProps?: Record<string, unknown>;
  inactiveProps?: Record<string, unknown>;
}) {
  const matched = to === '/environments/health';
  const { className: stateClass, ...stateProps } = (matched ? activeProps : inactiveProps) ?? {};
  return (
    <LinkStub
      to={to}
      className={[className, stateClass].filter(Boolean).join(' ')}
      {...stateProps}
      {...(matched ? { 'aria-current': 'page' } : {})}
      {...props}
    >
      {children}
    </LinkStub>
  );
}

mock.module('@tanstack/react-router', await routerWithLinkStub({ Link: CurrentAwareLink }));

const TABS = [
  { to: '/environments', label: 'Overview', exact: true },
  { to: '/environments/runtimes', label: 'Toolchains' },
  { to: '/environments/health', label: 'Health' },
] as const;

describe('TabNav', () => {
  const scrolled = jest.fn();
  const original = HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    scrolled.mockReset();
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, arg?: unknown) {
      scrolled(this, arg);
    };
  });

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = original;
  });

  it('scrolls sideways instead of wrapping, keeping the divider on the strip', async () => {
    const { TabNav } = await import('@/components/ui/TabNav');
    render(<TabNav label="Environments" tabs={TABS} />);

    const nav = screen.getByRole('navigation', { name: 'Environments' });
    // The divider belongs to the strip; scrolling belongs to the row inside it.
    // `overflow-x-auto` on the strip itself would clip the current tab's rule.
    expect(nav.className).toContain('border-b');
    expect(nav.className).not.toContain('overflow');
    expect(nav.className).not.toContain('flex-wrap');
    const list = screen.getByRole('link', { name: 'Overview' }).parentElement;
    expect(list?.className).toContain('overflow-x-auto');
    expect(list?.className).not.toContain('flex-wrap');
  });

  it('brings the current tab into view when it opens on a tab that is off-screen', async () => {
    const { TabNav } = await import('@/components/ui/TabNav');
    render(<TabNav label="Environments" tabs={TABS} />);

    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.calls[0]?.[0]).toBe(screen.getByRole('link', { name: 'Health' }));
    expect(scrolled.mock.calls[0]?.[1]).toEqual({ inline: 'nearest', block: 'nearest' });
  });

  it('follows the current tab when navigation moves it', async () => {
    const { TabNav } = await import('@/components/ui/TabNav');
    render(<TabNav label="Environments" tabs={TABS} />);
    scrolled.mockClear();

    // The router flips `aria-current` without rendering `TabNav` again.
    screen.getByRole('link', { name: 'Health' }).removeAttribute('aria-current');
    screen.getByRole('link', { name: 'Toolchains' }).setAttribute('aria-current', 'page');

    await waitFor(() =>
      expect(
        scrolled.mock.calls.map(([element]) => (element as HTMLElement).textContent)
      ).toContain('Toolchains')
    );
  });

  // A resource's own page lives under none of the tabs, so the router lights
  // none of them; the strip would say nothing about where the person is.
  it('lights a tab the URL is not under when it is marked current', async () => {
    const { TabNav } = await import('@/components/ui/TabNav');
    render(
      <TabNav
        label="Library"
        tabs={[
          { to: '/environments/library/skills', label: 'Skills', current: true },
          { to: '/environments/library/commands', label: 'Commands' },
        ]}
      />
    );

    const forced = screen.getByRole('link', { name: 'Skills' });
    expect(forced).toHaveAttribute('aria-current', 'page');
    expect(forced.className).toContain(TAB_CLASSES.active);
    expect(forced.className).not.toContain(TAB_CLASSES.idle);

    const other = screen.getByRole('link', { name: 'Commands' });
    expect(other).not.toHaveAttribute('aria-current');
    expect(other.className).toContain(TAB_CLASSES.idle);
    expect(other.className).not.toContain(TAB_CLASSES.active);
  });

  it('brings a tab marked current into view like one the router matched', async () => {
    const { TabNav } = await import('@/components/ui/TabNav');
    render(
      <TabNav
        label="Library"
        tabs={[
          { to: '/environments/library/commands', label: 'Commands' },
          { to: '/environments/library/settings', label: 'Settings', current: true },
        ]}
      />
    );

    expect(scrolled.mock.calls[0]?.[0]).toBe(screen.getByRole('link', { name: 'Settings' }));
  });

  it('moves the mark with `current` when the page changes kind', async () => {
    const { TabNav } = await import('@/components/ui/TabNav');
    const tabs = (current: 'skills' | 'commands') =>
      [
        { to: '/environments/library/skills', label: 'Skills', current: current === 'skills' },
        {
          to: '/environments/library/commands',
          label: 'Commands',
          current: current === 'commands',
        },
      ] as const;
    const { rerender } = render(<TabNav label="Library" tabs={tabs('skills')} />);
    expect(screen.getByRole('link', { name: 'Skills' })).toHaveAttribute('aria-current', 'page');

    rerender(<TabNav label="Library" tabs={tabs('commands')} />);

    expect(screen.getByRole('link', { name: 'Skills' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Commands' })).toHaveAttribute('aria-current', 'page');
  });
});
