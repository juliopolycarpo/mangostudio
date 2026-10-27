/**
 * Every top-level destination, as one flat list.
 *
 * The two tab strips hand their own route lists over rather than being
 * transcribed here, so a renamed settings tab renames its palette row and a new
 * one appears without anybody remembering this file exists.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import type { LinkProps } from '@tanstack/react-router';
import { House, Image, LayoutGrid, MessageSquare, MonitorCog, Settings } from 'lucide-react';

import { settingsNavGroups } from '@/components/settings/settings-nav';
import type { CommandItem } from '@/features/command-palette/lib/command-item';
import { environmentNavEntries } from '@/features/environments/environments-nav';

export interface NavigateCommandParams {
  readonly t: Messages;
  readonly navigate: (to: LinkProps['to']) => void;
}

export function navigateCommands({ t, navigate }: NavigateCommandParams): CommandItem[] {
  const surfaces: Array<{
    to: LinkProps['to'];
    label: string;
    icon: CommandItem['icon'];
    keywords?: string;
  }> = [
    { to: '/', label: t.chat.sectionLabel, icon: MessageSquare },
    { to: '/home', label: t.home.nav, icon: House },
    { to: '/studio', label: t.studio.title, icon: Image },
    { to: '/gallery', label: t.gallery.title, icon: LayoutGrid },
    ...environmentNavEntries(t.environments.tabs).map((entry) => ({
      to: entry.to,
      // The umbrella's own tabs read as bare words on their own ("Overview",
      // "Health"), so each is qualified by the surface it belongs to.
      label: `${t.environments.nav} · ${entry.label}`,
      icon: MonitorCog as CommandItem['icon'],
    })),
    ...settingsNavGroups(t.settings).flatMap((group) =>
      group.entries.map((entry) => ({
        to: entry.to,
        label: `${t.settings.title} · ${entry.label}`,
        // The heading a page sits under, searchable but not shown: typing
        // "observability" should reach Logs and Metrics, neither of which says
        // that word anywhere a user can see.
        keywords: group.label,
        icon: Settings as CommandItem['icon'],
      }))
    ),
  ];

  return surfaces.map(({ to, label, icon, keywords }) => ({
    id: `navigate:${to}`,
    section: 'navigate' as const,
    label,
    // No hint: the label already names the surface a tab belongs to
    // ("Settings · MCP"), and a raw route beside it is developer detail. The
    // path stays searchable, so typing "/settings/mcp" still reaches the row.
    keywords: [keywords, to].filter(Boolean).join('\n'),
    icon,
    run: () => navigate(to),
  }));
}
