import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/layout/Header';
import { Layout } from '@/components/layout/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { chatListQueryOptions, messagesQueryOptions } from '@/features/chat/queries';
import { CommandPaletteHost } from '@/features/command-palette/CommandPaletteHost';
import { useCommandPalette } from '@/features/command-palette/use-command-palette';
import { ExternalDisclosureGate } from '@/features/external-agents/ExternalDisclosureGate';
import { ExternalWorkspaceTrustGate } from '@/features/external-agents/ExternalWorkspaceTrustGate';
import { HeaderQuotaPill } from '@/features/external-agents/HeaderQuotaPill';
import { RunnerSelectorContainer } from '@/features/external-agents/RunnerSelectorContainer';
import { agentSettingsListQueryOptions } from '@/features/settings/agents/queries';
import { appSettingsQueryOptions } from '@/features/settings/app/queries';
import { WorkspaceBreadcrumb } from '@/features/workspace/components/WorkspaceBreadcrumb';
import { useBatchedGitSummaries } from '@/features/workspace/hooks/use-git-state';
import { useAppState } from '@/hooks/use-app-state';
import type { AppPage } from '@/hooks/use-chat-route-actions';
import { catalogQueryOptions } from '@/hooks/use-model-catalog';
import { AppContext } from '@/lib/app-context';
import { isNewChatShortcut } from '@/lib/keyboard';

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
  // Only chats with a workdir can have git state. `app.chats` holds its
  // identity between query updates, so memoizing here hands the hook the same
  // array on every one of this layout's per-token re-renders and it can bail
  // out on the reference instead of re-sorting the whole list.
  const gitChatIds = useMemo(
    () => app.chats.filter((chat) => chat.workdir).map((chat) => chat.id),
    [app.chats]
  );
  const gitSummaries = useBatchedGitSummaries(gitChatIds);

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

  let activePage: AppPage = 'chat';
  if (currentPath.includes('/gallery')) activePage = 'gallery';
  if (currentPath.includes('/settings')) activePage = 'settings';
  if (currentPath.includes('/studio')) activePage = 'studio';
  // `/library/*` only ever redirects into the umbrella now, but it stays mapped
  // so the nav does not flash a different entry while the redirect resolves.
  if (currentPath.includes('/environments') || currentPath.includes('/library'))
    activePage = 'environments';

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
          workspaceContext={
            // Gated on a workdir for the same reason the workspace rail gates the
            // Git panel on one: without it the breadcrumb still pays for a
            // `git/state` request and a realtime subscription per chat, and then
            // renders nothing because there is no repository to name.
            activePage === 'chat' && app.currentChatId && app.currentWorkdir ? (
              <WorkspaceBreadcrumb chatId={app.currentChatId} workdir={app.currentWorkdir} />
            ) : undefined
          }
          quotaPill={activePage === 'chat' ? <HeaderQuotaPill /> : undefined}
          onOpenCommandPalette={commandPalette.open}
          onMobileMenuToggle={() => setIsMobileSidebarOpen((v) => !v)}
        />

        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <Spinner size="lg" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </div>

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
