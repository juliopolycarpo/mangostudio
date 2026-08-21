/**
 * Stands in for TanStack Router's `Link` as a plain anchor.
 *
 * Router-only props are stripped so they never land on the DOM element;
 * everything else (className, aria-*, data-*) passes through to the anchor.
 *
 * The `mock.module('@tanstack/react-router', …)` call must stay in each test
 * file: `bun test` shares one module graph across files, so a preload-level
 * module mock would leak into every other file in the run.
 */

import type { ReactNode } from 'react';

export function LinkStub({
  to,
  children,
  activeProps: _activeProps,
  inactiveProps: _inactiveProps,
  activeOptions: _activeOptions,
  params: _params,
  ...props
}: {
  to: string;
  children?: ReactNode;
  activeProps?: unknown;
  inactiveProps?: unknown;
  activeOptions?: unknown;
  params?: unknown;
  [k: string]: unknown;
}) {
  return (
    <a href={to} {...props}>
      {children}
    </a>
  );
}
