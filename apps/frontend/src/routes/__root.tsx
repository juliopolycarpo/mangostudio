import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import type { AuthContext } from '@/lib/auth-context';
import { ToastProvider } from '@/components/ui/Toast';
import { I18nProvider } from '@/hooks/use-i18n';
import { ThemeProvider } from '@/hooks/use-theme';

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
