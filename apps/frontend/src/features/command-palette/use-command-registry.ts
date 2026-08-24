/**
 * Everything the open palette can offer, assembled from caches the shell
 * already holds.
 *
 * Mounted only while the palette is open — the host renders nothing otherwise —
 * so the environments list and external-agent discovery are paid for by opening
 * it, not by every page load. The chat list is already warm from the
 * authenticated route's loader, which is why sessions never show a skeleton.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import type { CommandItem } from '@/features/command-palette/lib/command-item';
import { actionCommands } from '@/features/command-palette/sources/action-commands';
import { environmentCommands } from '@/features/command-palette/sources/environment-commands';
import { navigateCommands } from '@/features/command-palette/sources/navigate-commands';
import { sessionCommands } from '@/features/command-palette/sources/session-commands';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { environmentScopeRoute } from '@/features/environments/use-environment-scope';
import { useExternalAccountLimits } from '@/features/external-agents/use-external-account-limits';
import {
  externalAgentSelectable,
  useExternalAgents,
} from '@/features/external-agents/useExternalAgents';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-context';
import { newChatShortcutHint } from '@/lib/keyboard';

export interface CommandRegistry {
  readonly items: readonly CommandItem[];
  /** True while a source is still filling in; the palette shows a skeleton row. */
  readonly isLoading: boolean;
}

/**
 * @param onRun Closes the palette. Every row runs through it, so no provider
 *   has to remember to dismiss and none can leave the overlay over the page it
 *   just navigated to.
 */
export function useCommandRegistry(onRun: () => void): CommandRegistry {
  const app = useApp();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { resolvedTheme, setConfig } = useTheme();
  // `currentEnvironmentId` is null exactly when no chat exists, and a null id
  // disables discovery — which would hide every "New chat with …" row from the
  // one user who has nothing *but* those rows to start from. A new chat always
  // starts on the local machine, so local is where its runners would have to be
  // discovered anyway.
  const external = useExternalAgents(app.currentEnvironmentId ?? LOCAL_ENVIRONMENT_ID);
  const environmentsQuery = useEnvironmentEntitiesQuery();

  // The data the rows are built from, named individually so the memo below can
  // depend on it without depending on the shell object that carries it. Each of
  // these is a query result or derived from one, so it changes when the rows
  // would actually differ.
  // `isGenerating` flips at turn boundaries, not per streamed token, so keying
  // the memo on it does not reintroduce the per-token rebuild the ref below
  // exists to avoid.
  const { agents, chats, currentChatId, isGenerating } = app;

  // The active runner's quota, on the same identity-guarded entry the header
  // pill and the selector chip share — so refreshing from the palette lights
  // their spinner instead of racing a second read of the same account.
  const activeDescriptor =
    (app.runner.kind === 'external' && external.find(app.runner.targetId)) || null;
  const quotaDescriptor = activeDescriptor?.capabilities.accountUsage ? activeDescriptor : null;
  const quota = useExternalAccountLimits(quotaDescriptor);

  // Read once for the palette's whole (short) lifetime. Reading it per render
  // would give every row a different anchor *and* invalidate the memo below on
  // every keystroke, rebuilding three hundred rows to move one timestamp by a
  // millisecond.
  const [nowMs] = useState(() => Date.now());

  // Every handler on the shell is rebuilt on every render — `useAppState`
  // returns a fresh literal, and `useChats` under it does too, so the callbacks
  // cannot be stable however they are memoized. Depending on them directly
  // would rebuild all three hundred rows once per streamed token, precisely
  // during the latency-sensitive path. Reading them at invocation time instead
  // keeps the memo keyed on data alone, and a row still runs the current
  // handler rather than the one captured when the palette opened.
  const appRef = useRef(app);
  appRef.current = app;

  const items = useMemo(() => {
    const sessions = sessionCommands({
      chats,
      badgeLabels: t.sidebar.runner,
      locale,
      nowMs,
      onSelect: (chatId) => {
        onRun();
        appRef.current.handleSelectChat(chatId);
      },
    });

    const actions = actionCommands({
      t,
      // Exactly the filter the runner selector applies: a subagent is not
      // something a chat can be handed to.
      agents: agents.filter((agent) => agent.role === 'primary' || agent.role === 'both'),
      externalAgents: external.agents.filter(
        (descriptor) =>
          externalAgentSelectable(descriptor) &&
          descriptor.unavailableReason !== 'disclosure-required'
      ),
      resolvedTheme,
      hasChat: currentChatId !== null,
      isGenerating,
      newChatShortcut: newChatShortcutHint(),
      quotaRefresh: quotaDescriptor
        ? {
            runnerLabel:
              t.externalAgents.target[quotaDescriptor.targetId] ?? quotaDescriptor.targetId,
            run: () => {
              onRun();
              quota.refresh();
            },
          }
        : null,
      onNewChat: () => {
        onRun();
        return appRef.current.handleNewChat();
      },
      onNewChatWithRunner: (runner, environmentId) => {
        onRun();
        return appRef.current.handleNewChatWithRunner(runner, environmentId);
      },
      onToggleTheme: () => {
        onRun();
        setConfig({ appTheme: resolvedTheme === 'dark' ? 'light' : 'dark' });
      },
      onOpenWorkdirPicker: () => {
        onRun();
        // The picker only renders on the chat surface, and the open flag lives
        // on the shell — so navigating first is what makes it appear when the
        // palette was opened from settings or the gallery.
        void navigate({ to: '/' });
        appRef.current.openWorkdirPicker();
      },
    });

    const navigation = navigateCommands({
      t,
      navigate: (to) => {
        onRun();
        void navigate({ to });
      },
    });

    const environments = environmentCommands({
      environments: environmentsQuery.data ?? [],
      t,
      onSelect: (environmentId) => {
        onRun();
        void navigate(environmentScopeRoute(environmentId));
      },
    });

    return [...sessions, ...actions, ...navigation, ...environments];
  }, [
    agents,
    chats,
    currentChatId,
    environmentsQuery.data,
    external.agents,
    isGenerating,
    locale,
    navigate,
    nowMs,
    onRun,
    quota.refresh,
    quotaDescriptor,
    resolvedTheme,
    setConfig,
    t,
  ]);

  return {
    items,
    // Only the two lazily-mounted sources can be cold. Sessions never are, so
    // the skeleton never delays the rows the palette is opened for.
    isLoading: external.isLoading || environmentsQuery.isLoading,
  };
}
