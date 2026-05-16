import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { ToastProvider } from '@/components/ui/Toast';
import { I18nProvider } from '@/hooks/use-i18n';
import { ThemeProvider } from '@/hooks/use-theme';
import type { AuthContext } from '@/lib/auth-context';
import { queryClient } from '@/lib/query-client';

export const Route = createRootRouteWithContext<{ auth: AuthContext; queryClient: QueryClient }>()({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <ToastProvider>
            <Outlet />
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  ),
});
