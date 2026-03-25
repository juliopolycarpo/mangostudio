import React from 'react';
import {
  render as tlRender,
  renderHook as tlRenderHook,
  RenderOptions,
  RenderHookOptions,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../src/components/ui/Toast';
import { I18nProvider } from '../../../src/hooks/use-i18n';

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
  return tlRender(
    <QueryClientProvider client={testQueryClient}>
      <I18nProvider>
        <ToastProvider>{ui}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
    options
  );
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
        <I18nProvider>
          <ToastProvider>{children}</ToastProvider>
        </I18nProvider>
      </QueryClientProvider>
    ),
  });
}

export * from '@testing-library/react';
export { render, renderHook };
