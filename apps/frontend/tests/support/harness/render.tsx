import React from 'react';
import { render as tlRender, renderHook as tlRenderHook, RenderOptions, RenderHookOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const createTestQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

function render(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  const testQueryClient = createTestQueryClient();
  return tlRender(
    <QueryClientProvider client={testQueryClient}>
      {ui}
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
        {children}
      </QueryClientProvider>
    ),
  });
}

export * from '@testing-library/react';
export { render, renderHook };
