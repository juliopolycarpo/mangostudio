/**
 * A resource's own page (`/library/skill:git-hygiene`) is under none of the
 * library tabs, so the router lights none of them there. The strip marks the
 * tab of the resource's kind instead, which is what keeps it saying where the
 * person is.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { ReactNode } from 'react';
import { TAB_CLASSES } from '@/components/ui/Tabs';
import { render, screen } from '../../../support/harness/render';
import { LinkStub, routerWithLinkStub } from '../../../support/mocks/router';

let params: Record<string, string | undefined> = {};

/** A link that dresses itself in `inactiveProps`, as the router does for a tab it did not match. */
function InactiveLink({
  to,
  children,
  className,
  activeProps: _active,
  inactiveProps,
  ...props
}: {
  to: string;
  children?: ReactNode;
  className?: string;
  activeProps?: unknown;
  inactiveProps?: Record<string, unknown>;
}) {
  const { className: stateClass, ...stateProps } = inactiveProps ?? {};
  return (
    <LinkStub
      to={to}
      className={[className, stateClass].filter(Boolean).join(' ')}
      {...stateProps}
      {...props}
    >
      {children}
    </LinkStub>
  );
}

mock.module(
  '@tanstack/react-router',
  await routerWithLinkStub({ Link: InactiveLink, useParams: () => params })
);

const scope = await import('@/features/environments/use-environment-scope');
mock.module('@/features/environments/use-environment-scope', () => ({
  ...scope,
  useEnvironmentScope: () => ({ environmentId: 'local' }),
}));

const { LibraryTabs } = await import('@/features/library/components/LibraryTabs');

describe('LibraryTabs', () => {
  it('lights the tab of the resource kind on a resource page', () => {
    params = { resourceKey: 'skill:git-hygiene' };
    render(<LibraryTabs />);

    const skills = screen.getByRole('link', { name: 'Skills' });
    expect(skills).toHaveAttribute('aria-current', 'page');
    expect(skills.className).toContain(TAB_CLASSES.active);
    expect(screen.getByRole('link', { name: 'Commands' })).not.toHaveAttribute('aria-current');
  });

  it('files a hook under the settings tab, as the page’s back link does', () => {
    params = { resourceKey: 'hook:pre-commit' };
    render(<LibraryTabs />);

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Skills' })).not.toHaveAttribute('aria-current');
  });

  it('marks nothing itself on a page with no resource, leaving the router to light its own', () => {
    params = {};
    render(<LibraryTabs />);

    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
  });
});
