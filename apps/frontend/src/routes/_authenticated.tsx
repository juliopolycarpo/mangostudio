import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { motion } from 'motion/react';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/layout/Header';
import { Layout } from '@/components/layout/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { useChatHasTurns } from '@/features/chat/hooks/use-chat-has-turns';
import { chatListQueryOptions, messagesQueryOptions } from '@/features/chat/queries';
import { CommandPaletteHost } from '@/features/command-palette/CommandPaletteHost';
import { useCommandPalette } from '@/features/command-palette/use-command-palette';
import { EnvironmentSelector } from '@/features/environments/components/EnvironmentSelector';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { ExternalDisclosureGate } from '@/features/external-agents/ExternalDisclosureGate';
import { ExternalWorkspaceTrustGate } from '@/features/external-agents/ExternalWorkspaceTrustGate';
import { HeaderQuotaPill } from '@/features/external-agents/HeaderQuotaPill';
import { RunnerSelectorContainer } from '@/features/external-agents/RunnerSelectorContainer';
import { environmentAlerts } from '@/features/home/lib/environment-health';
import { agentSettingsListQueryOptions } from '@/features/settings/agents/queries';
import { appSettingsQueryOptions } from '@/features/settings/app/queries';
import { WorkspaceBreadcrumb } from '@/features/workspace/components/WorkspaceBreadcrumb';
import { useBatchedGitSummaries } from '@/features/workspace/hooks/use-git-state';
import { useAppState } from '@/hooks/use-app-state';
import { catalogQueryOptions } from '@/hooks/use-model-catalog';
import { activePageForPath } from '@/lib/active-page';
import { AppContext } from '@/lib/app-context';
import { isNewChatShortcut } from '@/lib/keyboard';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context, location }) => {
    if (!context.auth.isAuthenticated) {
      redirect({
        to: '/login',
        search: { redirect: location.href },
        throw: true,
      });
    }
  },
  loader: async ({ context: { queryClient } }) => {
    const chatsPromise = queryClient.ensureQueryData(chatListQueryOptions());

    await Promise.all([
      chatsPromise,
      queryClient.ensureQueryData(catalogQueryOptions()),
      queryClient.ensureQueryData(appSettingsQueryOptions()),
      queryClient.ensureQueryData(agentSettingsListQueryOptions()),
    ]);

    const chats = await chatsPromise;
    const initialChatId = chats[0]?.id;
    if (initialChatId) {
      await queryClient.prefetchInfiniteQuery(messagesQueryOptions(initialChatId));
    }
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { auth } = Route.useRouteContext();
  const navigate = useNavigate();
  const app = useAppState();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const commandPalette = useCommandPalette();
  const { fade } = useMotionPresets();
  // Only chats with a workdir can have git state. `app.chats` holds its
  // identity between query updates, so memoizing here hands the hook the same
  // array on every one of this layout's per-token re-renders and it can bail
  // out on the reference instead of re-sorting the whole list.
  const gitChatIds = useMemo(
    () => app.chats.filter((chat) => chat.workdir).map((chat) => chat.id),
    [app.chats]
  );
  const gitSummaries = useBatchedGitSummaries(gitChatIds);
  // The same rule the hub's health card applies, at the one scope a nav badge
  // can have: no chat, so no "the machine this session runs on is offline"
  // warning — only machines that actually reported a fault. Reads the list the
  // runner selector already holds, so the badge costs no request and no probe.
  const environments = useEnvironmentEntitiesQuery().data;
  const environmentAlertCount = useMemo(
    () => environmentAlerts(environments ?? [], null).length,
    [environments]
  );
  // The first prompt settles the chat's identity — environment, workdir,
  // runner — so past it the header's selectors read rather than choose. The
  // lock is deliberately UI-level: the server keeps accepting repoints because
  // forking, session adoption and summarize-to-new-chat write through the same
  // endpoint.
  const chatHasTurns = useChatHasTurns(app.currentChatId);

  // New chat keeps its own chord rather than living in the palette's registry:
  // it is the one action worth reaching without reading a list first. Some
  // browsers reserve mod+N for themselves and never deliver it — the sidebar
  // button stays the reliable path.
  //
  // Read through a ref, not a dependency: `useChats()` hands back a fresh object
  // every render, so `handleNewChat` never memoizes and a dependency on it would
  // re-register the window listener once per render — once per streamed token,
  // since the generation state lives on this layout.
  const handleNewChatRef = useRef(app.handleNewChat);
  handleNewChatRef.current = app.handleNewChat;
  const closeCommandPalette = commandPalette.close;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || !isNewChatShortcut(event)) return;
      event.preventDefault();
      // The palette shows this chord on its own new-chat row, but the chord
      // lands here, not on the row's close-and-run wrapper — the palette input
      // has focus and the event bubbles to the window. Closing here keeps the
      // promise the row makes: the overlay must not stay up over the chat the
      // chord just created. Unconditional because closing a closed palette is
      // a bailed-out setState.
      closeCommandPalette();
      void handleNewChatRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeCommandPalette]);

  if (!auth.isAuthenticated) {
    void navigate({ to: '/login' });
    return null;
  }

  const activePage = activePageForPath(currentPath);

  return (
    <AppContext value={app}>
      <Layout
        currentPage={activePage}
        onNavigate={(page) => app.handleNavigate(page)}
        chats={app.chats}
        currentChatId={app.currentChatId}
        onSelectChat={app.handleSelectChat}
        onUpdateChatTitle={(chatId, title) => void app.handleUpdateChatTitle(chatId, title)}
        onDeleteChat={(chatId) => void app.handleDeleteChat(chatId)}
        onNewChat={() => void app.handleNewChat()}
        contextCache={app.contextCache}
        gitSummaries={gitSummaries}
        environmentAlertCount={environmentAlertCount}
        isMobileSidebarOpen={isMobileSidebarOpen}
        onMobileSidebarClose={() => setIsMobileSidebarOpen(false)}
        chatSidebarWidth={app.settings.workspaceSettings.chatSidebarWidth}
        onChatSidebarWidthChange={app.settings.setChatSidebarWidth}
      >
        <Header
          currentPage={activePage}
          onNewChat={() => void app.handleNewChat()}
          onNavigateToSettings={() => app.handleNavigate('settings')}
          runnerSelector={<RunnerSelectorContainer />}
          environmentSelector={
            // The chat's machine, moved up from the composer: it names the
            // session rather than the turn, and the header is where the rest of
            // the session's identity (runner, folder, branch) already lives.
            activePage === 'chat' && app.currentChatId && app.currentEnvironmentId ? (
              <EnvironmentSelector
                environmentId={app.currentEnvironmentId}
                disabled={app.isGenerating || chatHasTurns}
                onEnvironmentChange={(environmentId) =>
                  app.updateChatEnvironment(app.currentChatId as string, environmentId)
                }
              />
            ) : undefined
          }
          workspaceContext={
            // Gated on a workdir for the same reason the workspace rail gates the
            // Git panel on one: without it the breadcrumb still pays for a
            // `git/state` request and a realtime subscription per chat, and then
            // renders nothing because there is no repository to name.
            activePage === 'chat' && app.currentChatId && app.currentWorkdir ? (
              <WorkspaceBreadcrumb
                chatId={app.currentChatId}
                workdir={app.currentWorkdir}
                // Withheld rather than disabled once turns exist: a breadcrumb
                // that stops being a button reads as the fact it now is.
                {...(chatHasTurns ? {} : { onChangeWorkdir: app.openWorkdirPicker })}
              />
            ) : undefined
          }
          quotaPill={activePage === 'chat' ? <HeaderQuotaPill /> : undefined}
          onOpenCommandPalette={commandPalette.open}
          onMobileMenuToggle={() => setIsMobileSidebarOpen((v) => !v)}
        />

        {/* Keyed on the page rather than the pathname, so switching chats — or
            settings tabs — changes nothing here. Only a move between top-level
            destinations remounts this and plays the fade.

            No `AnimatePresence`: with one, the outgoing page would stay mounted
            for the length of its exit, holding a second copy of its queries and
            realtime subscriptions open. Re-keying instead unmounts it on the
            same tick React swaps the route, so the new page fades up over the
            shell with nothing lingering behind it and rapid navigation cannot
            stack exits.

            Opacity only, deliberately. A `transform` here would make this the
            containing block for every `position: fixed` descendant, and the
            pages below hold ~28 of them — dialogs, wizards, the gallery
            lightbox — none of which are portaled out. */}
        <motion.div
          key={activePage}
          initial={fade.initial}
          animate={fade.animate}
          transition={fade.transition}
          className="flex-1 min-h-0 overflow-hidden flex flex-col"
        >
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <Spinner size="lg" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </motion.div>

        {/* Mounted once, above every page: the send it gates can be raised from
            the composer on any of them, and the answer belongs to the workspace
            rather than to the view. */}
        <ExternalWorkspaceTrustGate />
        <ExternalDisclosureGate />
        <CommandPaletteHost open={commandPalette.isOpen} onClose={commandPalette.close} />
      </Layout>
    </AppContext>
  );
}
