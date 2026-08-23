/**
 * The things the palette *does* rather than navigates to.
 *
 * Each one is already reachable somewhere in the chrome; what the palette adds
 * is that a multi-harness user can start a Codex session without first finding
 * the runner pill, and can flip the theme without opening settings.
 *
 * Nothing here fans out a request across machines. "Refresh quota" is the
 * active runner's, singular, because a vendor quota read costs a subprocess on
 * somebody else's box — a keystroke that probes every discovered agent at once
 * is not an affordance, it is a stampede.
 */

import type { AgentProfile } from '@mangostudio/shared/agents';
import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import type { Messages } from '@mangostudio/shared/i18n';
import { FolderOpen, Moon, Plus, RefreshCw, Sun } from 'lucide-react';
import type { CommandItem } from '@/features/command-palette/lib/command-item';
import { formatMessage } from '@/lib/i18n-format';

interface QuotaRefreshAction {
  /** The vendor whose allowance is being re-read, named in the row. */
  readonly runnerLabel: string;
  readonly run: () => void;
}

export interface ActionCommandParams {
  readonly t: Messages;
  /** Primary agent profiles — the ones a chat can actually be handed to. */
  readonly agents: readonly AgentProfile[];
  /** Discovery's answer for the current environment; unusable ones are dropped. */
  readonly externalAgents: readonly ExternalAgentDescriptor[];
  readonly resolvedTheme: 'dark' | 'light';
  /** False on a shell with no chat selected, which is what hides the workdir row. */
  readonly hasChat: boolean;
  readonly newChatShortcut: string;
  /** Null unless the active runner is an external one that reports usage. */
  readonly quotaRefresh: QuotaRefreshAction | null;
  readonly onNewChat: () => void | Promise<void>;
  readonly onNewChatWithRunner: (runner: ChatRunnerConfiguration) => void | Promise<void>;
  readonly onToggleTheme: () => void;
  readonly onOpenWorkdirPicker: () => void;
}

export function actionCommands({
  t,
  agents,
  externalAgents,
  resolvedTheme,
  hasChat,
  newChatShortcut,
  quotaRefresh,
  onNewChat,
  onNewChatWithRunner,
  onToggleTheme,
  onOpenWorkdirPicker,
}: ActionCommandParams): CommandItem[] {
  const labels = t.commandPalette.actions;

  const items: CommandItem[] = [
    {
      id: 'action:new-chat',
      section: 'actions',
      label: t.chat.newChat,
      icon: Plus,
      shortcut: newChatShortcut,
      run: onNewChat,
    },
  ];

  for (const agent of agents) {
    items.push({
      id: `action:new-chat-agent:${agent.id}`,
      section: 'actions',
      label: formatMessage(labels.newChatWith, { runner: agent.name }),
      hint: t.library.targets.mangostudio,
      icon: Plus,
      run: () => onNewChatWithRunner({ kind: 'mangostudio', agentId: agent.id }),
    });
  }

  for (const descriptor of externalAgents) {
    items.push({
      id: `action:new-chat-external:${descriptor.targetId}`,
      section: 'actions',
      label: formatMessage(labels.newChatWith, {
        // A target this bundle predates still names itself with its raw id,
        // the same way the runner pill and the sidebar badge degrade.
        runner: t.externalAgents.target[descriptor.targetId] ?? descriptor.targetId,
      }),
      hint: descriptor.account?.label ?? undefined,
      keywords: descriptor.targetId,
      icon: Plus,
      run: () => onNewChatWithRunner({ kind: 'external', targetId: descriptor.targetId }),
    });
  }

  items.push({
    id: 'action:toggle-theme',
    section: 'actions',
    // Named for what it will do, not for what is on screen: "Light theme" as a
    // row title is ambiguous about which state it leaves you in.
    label: resolvedTheme === 'dark' ? labels.switchToLight : labels.switchToDark,
    icon: resolvedTheme === 'dark' ? Sun : Moon,
    // Both theme names, not just the one this row moves to. Somebody in dark
    // mode types "dark" as often as "light" — they are naming the subject, not
    // the destination — and the label can only ever contain one of the two.
    keywords: [
      t.settings.appearance.appTheme.label,
      t.settings.appearance.appTheme.dark,
      t.settings.appearance.appTheme.light,
      t.settings.tabs.appearance,
    ].join('\n'),
    run: onToggleTheme,
  });

  if (hasChat) {
    items.push({
      id: 'action:workdir',
      section: 'actions',
      label: labels.chooseWorkdir,
      icon: FolderOpen,
      run: onOpenWorkdirPicker,
    });
  }

  if (quotaRefresh) {
    items.push({
      id: 'action:refresh-quota',
      section: 'actions',
      label: formatMessage(labels.refreshQuota, { runner: quotaRefresh.runnerLabel }),
      icon: RefreshCw,
      run: quotaRefresh.run,
    });
  }

  return items;
}
