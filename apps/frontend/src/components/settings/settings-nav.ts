/**
 * The settings surface's route list, grouped, in one place.
 *
 * Two things navigate settings — the sidebar and the command palette — and a
 * second hand-written copy of fifteen route/label pairs is one rename away from
 * a palette entry that opens the wrong page or names a tab that no longer
 * exists.
 *
 * The grouping lives here rather than in the component because it is not only
 * layout: the palette shows a page's group as searchable text, so typing
 * "observability" finds Logs and Metrics without either word appearing in their
 * names. One model, both surfaces.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import type { LinkProps } from '@tanstack/react-router';

interface SettingsNavEntry {
  readonly to: LinkProps['to'];
  readonly label: string;
}

export interface SettingsNavGroup {
  /** Stable across renames — a React key and a test's handle on the group. */
  readonly id: keyof Messages['settings']['groups'];
  readonly label: string;
  readonly entries: readonly SettingsNavEntry[];
}

/**
 * Every settings page, under the heading it belongs to.
 *
 * Five headings, none of them holding a single page: a group of one is a
 * heading that costs a line and answers nothing. Connectors sits with the
 * providers because a connector is a provider account, not a third-party
 * integration, and Tools sits with the agents that are the only things that
 * call them.
 *
 * // Usage: settingsNavGroups(t.settings).flatMap((group) => group.entries)
 */
export function settingsNavGroups(labels: Messages['settings']): SettingsNavGroup[] {
  const { tabs, groups } = labels;
  return [
    {
      id: 'general',
      label: groups.general,
      entries: [
        { to: '/settings/general', label: tabs.general },
        { to: '/settings/appearance', label: tabs.appearance },
      ],
    },
    {
      id: 'models',
      label: groups.models,
      entries: [
        { to: '/settings/providers', label: tabs.providers },
        { to: '/settings/connectors', label: tabs.connectors },
        { to: '/settings/prompts', label: tabs.prompts },
        { to: '/settings/context', label: tabs.context },
      ],
    },
    {
      id: 'agents',
      label: groups.agents,
      entries: [
        { to: '/settings/agents', label: tabs.agents },
        { to: '/settings/external-agents', label: tabs.externalAgents },
        { to: '/settings/skills', label: tabs.skills },
        { to: '/settings/tools', label: tabs.tools },
      ],
    },
    {
      id: 'integrations',
      label: groups.integrations,
      entries: [
        { to: '/settings/mcp', label: tabs.mcp },
        { to: '/settings/git', label: tabs.git },
        { to: '/settings/external-api', label: tabs.externalApi },
      ],
    },
    {
      id: 'observability',
      label: groups.observability,
      entries: [
        { to: '/settings/metrics', label: tabs.metrics },
        { to: '/settings/logs', label: tabs.logs },
      ],
    },
  ];
}
