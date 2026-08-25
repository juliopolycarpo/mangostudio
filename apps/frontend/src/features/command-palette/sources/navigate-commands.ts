/**
 * Every top-level destination, as one flat list.
 *
 * The two tab strips hand their own route lists over rather than being
 * transcribed here, so a renamed settings tab renames its palette row and a new
 * one appears without anybody remembering this file exists.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import type { LinkProps } from '@tanstack/react-router';
import {
  Image,
  LayoutDashboard,
  LayoutGrid,
  MessageSquare,
  MonitorCog,
  Settings,
} from 'lucide-react';
import { settingsNavEntries } from '@/components/settings/settings-nav';
import type { CommandItem } from '@/features/command-palette/lib/command-item';
import { environmentNavEntries } from '@/features/environments/environments-nav';

export interface NavigateCommandParams {
  readonly t: Messages;
  readonly navigate: (to: LinkProps['to']) => void;
}

export function navigateCommands({ t, navigate }: NavigateCommandParams): CommandItem[] {
  const surfaces: Array<{ to: LinkProps['to']; label: string; icon: CommandItem['icon'] }> = [
    { to: '/', label: t.chat.sectionLabel, icon: MessageSquare },
    { to: '/home', label: t.home.nav, icon: LayoutDashboard },
    { to: '/studio', label: t.studio.title, icon: Image },
    { to: '/gallery', label: t.gallery.title, icon: LayoutGrid },
    ...environmentNavEntries(t.environments.tabs).map((entry) => ({
      to: entry.to,
      // The umbrella's own tabs read as bare words on their own ("Overview",
      // "Health"), so each is qualified by the surface it belongs to.
      label: `${t.environments.nav} · ${entry.label}`,
      icon: MonitorCog as CommandItem['icon'],
    })),
    ...settingsNavEntries(t.settings.tabs).map((entry) => ({
      to: entry.to,
      label: `${t.settings.title} · ${entry.label}`,
      icon: Settings as CommandItem['icon'],
    })),
  ];

  return surfaces.map(({ to, label, icon }) => ({
    id: `navigate:${to}`,
    section: 'navigate' as const,
    label,
    // Shown and searched both — the path is how a power user confirms which of
    // two similarly named tabs a row opens, and how they reach it by typing.
    hint: to ?? undefined,
    icon,
    run: () => navigate(to),
  }));
}
