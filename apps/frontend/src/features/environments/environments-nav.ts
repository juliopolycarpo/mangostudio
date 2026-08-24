/**
 * The environments umbrella's tab list, in one place — same reason the settings
 * one is: the tab strip and the command palette both navigate it.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import type { LinkProps } from '@tanstack/react-router';

export interface EnvironmentNavEntry {
  readonly to: LinkProps['to'];
  readonly label: string;
  /**
   * Lights only on its own URL. The umbrella root is every other tab's prefix,
   * so without this it stays lit on all of them.
   */
  readonly exact?: boolean;
}

export function environmentNavEntries(
  labels: Messages['environments']['tabs']
): EnvironmentNavEntry[] {
  return [
    { to: '/environments', label: labels.overview, exact: true },
    { to: '/environments/runtimes', label: labels.runtimes },
    { to: '/environments/agents', label: labels.agents },
    { to: '/environments/health', label: labels.health },
    { to: '/environments/library', label: labels.library },
  ];
}
