import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { Suspense, useState } from 'react';
import { Header } from '@/components/layout/Header';
import { Layout } from '@/components/layout/Layout';
import { Spinner } from '@/components/ui/Spinner';
import { chatListQueryOptions, messagesQueryOptions } from '@/features/chat/queries';
import { agentSettingsListQueryOptions } from '@/features/settings/agents/queries';
import { appSettingsQueryOptions } from '@/features/settings/app/queries';
import { useAppState } from '@/hooks/use-app-state';
import type { AppPage } from '@/hooks/use-chat-route-actions';
import { catalogQueryOptions } from '@/hooks/use-model-catalog';
import { AppContext } from '@/lib/app-context';

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

  if (!auth.isAuthenticated) {
    void navigate({ to: '/login' });
    return null;
  }

  let activePage: AppPage = 'chat';
  if (currentPath.includes('/gallery')) activePage = 'gallery';
  if (currentPath.includes('/settings')) activePage = 'settings';
  if (currentPath.includes('/studio')) activePage = 'studio';
  if (currentPath.includes('/environments')) activePage = 'environments';

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
        isMobileSidebarOpen={isMobileSidebarOpen}
        onMobileSidebarClose={() => setIsMobileSidebarOpen(false)}
        chatSidebarWidth={app.settings.workspaceSettings.chatSidebarWidth}
        onChatSidebarWidthChange={app.settings.setChatSidebarWidth}
      >
        <Header
          activeModel={app.activeModel}
          activeModels={app.activeModels}
          isModelSelectorDisabled={app.isModelSelectorDisabled}
          currentChatId={app.currentChatId}
          currentPage={activePage}
          onUpdateChatModel={(chatId, model) => void app.handleUpdateChatModel(chatId, model)}
          onSetPageModel={(model) => {
            if (app.currentChatId) {
              void app.handleUpdateChatModel(app.currentChatId, model);
            }
          }}
          onNewChat={() => void app.handleNewChat()}
          onNavigateToSettings={() => app.handleNavigate('settings')}
          modelCatalog={app.catalog}
          lockedProvider={app.lockedProvider}
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
      </Layout>
    </AppContext>
  );
}
