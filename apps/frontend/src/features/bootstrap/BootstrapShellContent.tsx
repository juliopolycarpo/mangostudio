import type { ReactNode } from 'react';
import { BootstrapErrorPanel } from '@/components/layout/BootstrapErrorPanel';
import type { ShellBootstrapState } from './use-shell-bootstrap';

/**
 * The shell's content region: the page, or the bootstrap panel in its place.
 *
 * A shell request that failed replaces the page, not the shell — navigation
 * stays usable, and the retry asks again for exactly what failed. This is a
 * conditional render, not a second error boundary: the route's own boundary
 * still owns everything the loader throws.
 *
 * @example
 * <BootstrapShellContent bootstrap={useShellBootstrap()}>
 *   <Outlet />
 * </BootstrapShellContent>
 */
export function BootstrapShellContent({
  bootstrap,
  children,
}: {
  readonly bootstrap: ShellBootstrapState;
  readonly children: ReactNode;
}) {
  if (bootstrap.failed.length === 0) return children;
  return (
    <BootstrapErrorPanel
      placement="content"
      error={bootstrap.error}
      failed={bootstrap.failed}
      onRetry={bootstrap.retry}
    />
  );
}
