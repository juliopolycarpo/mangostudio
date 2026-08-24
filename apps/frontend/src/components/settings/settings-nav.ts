/**
 * The settings surface's route list, in one place.
 *
 * Two things navigate settings — the tab strip and the command palette — and a
 * second hand-written copy of fifteen route/label pairs is one rename away from
 * a palette entry that opens the wrong page or names a tab that no longer
 * exists.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import type { LinkProps } from '@tanstack/react-router';

export interface SettingsNavEntry {
  readonly to: LinkProps['to'];
  readonly label: string;
}

export function settingsNavEntries(labels: Messages['settings']['tabs']): SettingsNavEntry[] {
  return [
    { to: '/settings/general', label: labels.general },
    { to: '/settings/connectors', label: labels.connectors },
    { to: '/settings/providers', label: labels.providers },
    { to: '/settings/agents', label: labels.agents },
    { to: '/settings/prompts', label: labels.prompts },
    { to: '/settings/appearance', label: labels.appearance },
    { to: '/settings/context', label: labels.context },
    { to: '/settings/git', label: labels.git },
    { to: '/settings/tools', label: labels.tools },
    { to: '/settings/skills', label: labels.skills },
    { to: '/settings/mcp', label: labels.mcp },
    { to: '/settings/external-api', label: labels.externalApi },
    { to: '/settings/external-agents', label: labels.externalAgents },
    { to: '/settings/metrics', label: labels.metrics },
    { to: '/settings/logs', label: labels.logs },
  ];
}
