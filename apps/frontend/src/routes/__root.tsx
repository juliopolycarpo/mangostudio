import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthContext } from '@/lib/auth-context';
import { ToastProvider } from '@/components/ui/Toast';
import { I18nProvider } from '@/hooks/use-i18n';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      staleTime: 1000 * 30,
    },
  },
});

export const Route = createRootRouteWithContext<{ auth: AuthContext }>()({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <Outlet />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  ),
});