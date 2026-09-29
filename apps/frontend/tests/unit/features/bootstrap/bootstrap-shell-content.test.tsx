/**
 * The shell's content region over a refused bootstrap request: the page, or
 * the bootstrap panel in its place, with a retry scoped to what failed.
 *
 * Mounted with the real hook against a fake hub, so the request counts below
 * are what a retry actually costs — the acceptance is that it asks again for
 * the failed responsibility and nothing else, and creates nothing.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import { BootstrapShellContent } from '../../../../src/features/bootstrap/BootstrapShellContent';
import {
  loadShellBootstrap,
  settleShellQuery,
} from '../../../../src/features/bootstrap/shell-bootstrap';
import { useShellBootstrap } from '../../../../src/features/bootstrap/use-shell-bootstrap';
import { chatListQueryOptions } from '../../../../src/features/chat/queries';
import { catalogQueryOptions } from '../../../../src/hooks/use-model-catalog';
import { renderWithRouter } from '../../../support/harness/render-with-router';
import {
  createShellBootstrapHub,
  FIRST_CHAT_MESSAGES_PATH,
  type ShellBootstrapHub,
} from '../../../support/mocks/shell-bootstrap-scenario';

let hub: ShellBootstrapHub | undefined;

afterEach(() => {
  hub?.restore();
  hub = undefined;
});

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function ShellRegion() {
  return (
    <BootstrapShellContent bootstrap={useShellBootstrap()}>
      <div data-testid="page">page</div>
    </BootstrapShellContent>
  );
}

async function renderRegion(queryClient: QueryClient) {
  await renderWithRouter(
    <QueryClientProvider client={queryClient}>
      <ShellRegion />
    </QueryClientProvider>
  );
}

/** Every request the fake hub saw that was not a read. */
function writes(): string[] {
  return (
    globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit?][] } }
  ).mock.calls
    .filter(([, init]) => (init?.method ?? 'GET').toUpperCase() !== 'GET')
    .map(([input]) => String(input));
}

describe('BootstrapShellContent', () => {
  it('renders the page when every shell request loaded', async () => {
    hub = createShellBootstrapHub().install();
    const queryClient = newQueryClient();
    await loadShellBootstrap(queryClient);

    await renderRegion(queryClient);

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(screen.queryByTestId('bootstrap-error')).toBeNull();
  });

  it('puts the panel in place of the page, naming what did not load', async () => {
    hub = createShellBootstrapHub().refuse('catalog', 'server-error').install();
    const queryClient = newQueryClient();
    await loadShellBootstrap(queryClient);

    await renderRegion(queryClient);

    expect(screen.queryByTestId('page')).toBeNull();
    expect(screen.getByTestId('bootstrap-error').parentElement).toHaveAttribute(
      'data-placement',
      'content'
    );
    expect(screen.getByTestId('bootstrap-error-failed')).toHaveTextContent(
      en.errors.bootstrap.failed.replace('{items}', en.errors.bootstrap.responsibilities.catalog)
    );
  });

  it('retries only the failed request, then shows the page with nothing created', async () => {
    hub = createShellBootstrapHub().refuse('catalog', 'rate-limited').install();
    const queryClient = newQueryClient();
    await loadShellBootstrap(queryClient);
    await renderRegion(queryClient);
    hub.answer('catalog');

    fireEvent.click(screen.getByTestId('bootstrap-error-retry'));

    await waitFor(() => expect(screen.getByTestId('page')).toBeInTheDocument());
    const counts = {
      catalog: hub.requestCount('catalog'),
      chats: hub.requestCount('chats'),
      agents: hub.requestCount('agents'),
      messages: hub.requestCount(FIRST_CHAT_MESSAGES_PATH),
    };
    expect(
      counts,
      `expected requests after one retry: catalog 2, others 1 | received: ${JSON.stringify(counts)}`
    ).toEqual({ catalog: 2, chats: 1, agents: 1, messages: 0 });
    expect(writes(), 'expected no writes from a retry').toEqual([]);
  });

  it('keeps the panel when the retry is refused too', async () => {
    hub = createShellBootstrapHub().refuse('chats', 'server-error').install();
    const queryClient = newQueryClient();
    await loadShellBootstrap(queryClient);
    await renderRegion(queryClient);

    fireEvent.click(screen.getByTestId('bootstrap-error-retry'));

    await waitFor(() => expect(hub?.requestCount('chats')).toBe(2));
    // Settled: the button is usable again, and the page never appeared.
    await waitFor(() => expect(screen.getByTestId('bootstrap-error-retry')).not.toBeDisabled());
    expect(screen.queryByTestId('page')).toBeNull();
  });
});

/** Mounts the hook against a client the test holds, so it can drive the cache. */
function renderWithClient(queryClient: QueryClient) {
  return renderHook(() => useShellBootstrap(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  }).result;
}

describe('useShellBootstrap', () => {
  it('keeps reporting a failure while its retry is in flight', async () => {
    hub = createShellBootstrapHub().refuse('catalog', 'server-error').install();
    const queryClient = newQueryClient();
    await loadShellBootstrap(queryClient);
    const hook = renderWithClient(queryClient);

    // A refetch of a query with no data resets it to `pending` and clears its
    // error; the failure must still be reported until data actually arrives,
    // or the page would mount against a catalog that is still missing.
    await act(async () => {
      void queryClient.fetchQuery({
        queryKey: catalogQueryOptions().queryKey,
        // Never settles: the retry is still in flight when the hook is read.
        queryFn: () => new Promise<never>(() => undefined),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(queryClient.getQueryState(catalogQueryOptions().queryKey)?.status).toBe('pending');
    expect(
      hook.current.failed,
      `expected failed responsibilities during a retry: ["catalog"] | received: ${JSON.stringify(hook.current.failed)}`
    ).toEqual(['catalog']);
  });

  it('flags an authentication failure so the layout shows nothing protected', async () => {
    hub = createShellBootstrapHub().refuse('chats', 'unauthorized').install();
    const queryClient = newQueryClient();
    await settleShellQuery(queryClient, chatListQueryOptions());

    const hook = renderWithClient(queryClient);

    expect(hook.current.isAuthFailure).toBe(true);
    expect(hook.current.failed).toEqual(['chats']);
  });
});
