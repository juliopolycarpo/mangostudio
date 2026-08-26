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
import { FolderOpen, GitPullRequest, Moon, Plus, RefreshCw, Sun } from 'lucide-react';
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
  /**
   * True while a turn is streaming. Hides the workdir row for the same reason
   * the composer disables its workdir chip: repointing the binding mid-turn
   * makes the hub reap the live external session with `session-lost`.
   */
  readonly isGenerating: boolean;
  /**
   * True once the active chat has turns, at which point its workdir is settled.
   * This gate is what keeps the palette from being the one surface that still
   * repoints a locked chat's folder after the header stopped offering it.
   */
  readonly chatHasTurns: boolean;
  readonly newChatShortcut: string;
  /** Null unless the active runner is an external one that reports usage. */
  readonly quotaRefresh: QuotaRefreshAction | null;
  readonly onNewChat: () => void | Promise<void>;
  /**
   * @param environmentId The machine the runner was discovered on, for the
   *   rows where that is not the same thing as the default. Agent profiles are
   *   the hub's own and pass nothing.
   */
  readonly onNewChatWithRunner: (
    runner: ChatRunnerConfiguration,
    environmentId?: string
  ) => void | Promise<void>;
  readonly onToggleTheme: () => void;
  readonly onOpenWorkdirPicker: () => void;
  /**
   * Navigates to the chat surface and asks its rail for the GitHub panel.
   *
   * Async because the two halves are ordered: the rail hears the request as a
   * fire-and-forget event, so it has to be mounted before the request is made.
   */
  readonly onOpenGithubPanel: () => void | Promise<void>;
  /**
   * Navigates to the chat surface, opens the GitHub panel, and asks it to
   * switch to the pull requests tab with the create form open — what the row
   * labeled "Create pull request" promises rather than a second "open the
   * panel" affordance.
   */
  readonly onCreateGithubPr: () => void | Promise<void>;
}

export function actionCommands({
  t,
  agents,
  externalAgents,
  resolvedTheme,
  hasChat,
  isGenerating,
  chatHasTurns,
  newChatShortcut,
  quotaRefresh,
  onNewChat,
  onNewChatWithRunner,
  onToggleTheme,
  onOpenWorkdirPicker,
  onOpenGithubPanel,
  onCreateGithubPr,
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
      // The descriptor's own machine, not the shell's: this list is discovery's
      // answer for one environment, and a vendor installed over there is not
      // installed here just because a new chat starts local.
      run: () =>
        onNewChatWithRunner(
          { kind: 'external', targetId: descriptor.targetId },
          descriptor.environmentId
        ),
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

  // Omitted rather than disabled while a turn streams or once turns exist: a
  // CommandItem has no disabled affordance, and offering the row would invite
  // exactly the write the header's breadcrumb withholds on a settled chat.
  if (hasChat && !isGenerating && !chatHasTurns) {
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

  // The rail has no keyboard shortcut for switching panels — `lib/keyboard.ts`
  // has only mod+K and mod+N — so these three rows are the GitHub panel's
  // entire shortcut story rather than a nicety. All of them need a chat,
  // because the rail only exists on the chat surface.
  if (hasChat) {
    items.push(
      {
        id: 'action:github-panel',
        section: 'actions',
        label: labels.openGithubPanel,
        keywords: t.github.title,
        icon: GitPullRequest,
        run: onOpenGithubPanel,
      },
      {
        id: 'action:github-create-pr',
        section: 'actions',
        // Reuses the panel's own wording rather than a second translation of
        // the same sentence; the row runs the same affordance the panel does.
        label: t.github.actions.createPr,
        icon: GitPullRequest,
        run: onCreateGithubPr,
      },
      {
        id: 'action:github-review-requests',
        section: 'actions',
        label: labels.reviewRequests,
        keywords: t.github.panel.inbox,
        icon: GitPullRequest,
        run: onOpenGithubPanel,
      }
    );
  }

  return items;
}
