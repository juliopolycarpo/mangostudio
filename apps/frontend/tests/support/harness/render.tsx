import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  type RenderHookOptions,
  type RenderOptions,
  render as tlRender,
  renderHook as tlRenderHook,
} from '@testing-library/react';
import type React from 'react';
import { ToastProvider } from '../../../src/components/ui/Toast';
import { registerCapabilityInvalidationSources } from '../../../src/features/chat/hooks/capability-invalidation';
import { I18nProvider } from '../../../src/hooks/use-i18n';
import { ThemeProvider } from '../../../src/hooks/use-theme';

const createTestQueryClient = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  registerCapabilityInvalidationSources(queryClient);
  return queryClient;
};

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

/**
 * Lets everything React has pending settle inside `act`.
 *
 * Two things in this app resolve after the render that started them: a
 * `lazy()` chunk behind a Suspense boundary (`MarkdownContent`), and React
 * Query announcing a cache change through its own `setTimeout(callback, 0)`.
 * Both land inside the test body on an idle machine and after it in a loaded
 * full-lane run — which prints "not wrapped in act(...)" against a green test
 * and blames whichever file the runner is on.
 *
 * Call it after a render whose content arrives asynchronously, before
 * asserting. Do not call it while fake timers are installed: a `setTimeout`
 * does not fire on its own then. Use the timer harness there instead.
 */
async function flushAsyncRender(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export * from '@testing-library/react';
export { flushAsyncRender, render, renderHook };
