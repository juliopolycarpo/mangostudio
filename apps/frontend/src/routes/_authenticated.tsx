import {
  createFileRoute,
  redirect,
  Outlet,
  useRouterState,
  useNavigate,
} from '@tanstack/react-router';
import { useEffect, Suspense } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { Layout } from '@/components/layout/Layout';
import { Header } from '@/components/layout/Header';
import { useAppState } from '@/hooks/use-app-state';
import { AppContext } from '@/lib/app-context';

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context, location }) => {
    if (!context.auth.isAuthenticated) {
      throw redirect({
        to: '/login',
        search: { redirect: location.href },
      });
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

  useEffect(() => {
    void app.initialize();
  }, [app.initialize]);

  if (!auth.isAuthenticated) {
    void navigate({ to: '/login' });
    return null;
  }

  let activePage: 'chat' | 'gallery' | 'settings' = 'chat';
  if (currentPath.includes('/gallery')) activePage = 'gallery';
  if (currentPath.includes('/settings')) activePage = 'settings';

  return (
    <AppContext.Provider value={app}>
      <Layout
        currentPage={activePage}
        onNavigate={(page) => app.handleNavigate(page)}
        chats={app.chats}
        currentChatId={app.currentChatId}
        onSelectChat={app.handleSelectChat}
        onUpdateChatTitle={app.handleUpdateChatTitle}
        onDeleteChat={app.handleDeleteChat}
        onNewChat={app.handleNewChat}
        contextCache={app.contextCache}
      >
        <Header
          activeModel={app.activeModel}
          activeModels={app.activeModels}
          isModelSelectorDisabled={app.isModelSelectorDisabled}
          composerMode={app.composerMode}
          currentChatId={app.currentChatId}
          currentPage={activePage}
          onUpdateChatModel={app.handleUpdateChatModel}
          onSetPageModel={(model) => {
            if (app.currentChatId) {
              void app.handleUpdateChatModel(app.currentChatId, model);
            }
          }}
          onNewChat={app.handleNewChat}
          onNavigateToSettings={() => app.handleNavigate('settings')}
          modelCatalog={app.catalog}
          lockedProvider={app.lockedProvider}
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
    </AppContext.Provider>
  );
}
