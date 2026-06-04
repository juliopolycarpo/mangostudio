import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type RenderHookOptions,
  type RenderOptions,
  render as tlRender,
  renderHook as tlRenderHook,
} from '@testing-library/react';
import type React from 'react';
import { ToastProvider } from '../../../src/components/ui/Toast';
import { I18nProvider } from '../../../src/hooks/use-i18n';
import { ThemeProvider } from '../../../src/hooks/use-theme';

const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

function render(ui: React.ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  const testQueryClient = createTestQueryClient();
  // Providers go through the `wrapper` option (not inline) so testing-library's
  // `rerender` keeps them mounted across re-renders.
  return tlRender(ui, {
    ...options,
    wrapper: ({ children }) => (
      <QueryClientProvider client={testQueryClient}>
        <ThemeProvider>
          <I18nProvider>
            <ToastProvider>{children}</ToastProvider>
          </I18nProvider>
        </ThemeProvider>
      </QueryClientProvider>
    ),
  });
}

function renderHook<Result, Props>(
  render: (initialProps: Props) => Result,
  options?: Omit<RenderHookOptions<Props>, 'wrapper'>
) {
  const testQueryClient = createTestQueryClient();
  return tlRenderHook(render, {
    ...options,
    wrapper: ({ children }) => (
      <QueryClientProvider client={testQueryClient}>
        <ThemeProvider>
          <I18nProvider>
            <ToastProvider>{children}</ToastProvider>
          </I18nProvider>
        </ThemeProvider>
      </QueryClientProvider>
    ),
  });
}

export * from '@testing-library/react';
export { render, renderHook };
