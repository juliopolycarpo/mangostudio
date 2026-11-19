/**
 * The registry's memo, which is the palette's only per-render cost while a turn
 * is streaming.
 *
 * The shell re-renders once per streamed token, and `useAppState` returns a
 * fresh object literal each time — `useChats` under it does too, so its
 * callbacks are new on every render however they are memoized. A memo keyed on
 * that object rebuilds every row per token and hands the palette a new `items`
 * identity, which reranks the whole list again. Nothing here would have
 * changed; the work is pure waste on the latency path.
 */

import { describe, expect, it, jest, mock } from 'bun:test';

import type { AgentProfile } from '@mangostudio/shared/agents';
import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import type { Chat } from '@mangostudio/shared/chat';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { type ChatPaging, NO_MORE_CHATS } from '@/features/chat/chat-list-pages';
import type { CommandItem } from '@/features/command-palette/lib/command-item';
import { onGithubCreatePrRequest } from '@/features/github/lib/github-panel-request';
import { githubPrsQueryOptions } from '@/features/github/queries';
import {
  onRailPanelRequest,
  RAIL_PANEL_REQUEST_WINDOW_MS,
} from '@/features/workspace/rail/rail-panel-request';
import type { useAppState } from '@/hooks/use-app-state';
import { AppContext } from '@/lib/app-context';

import { act, flushAsyncRender, render, waitFor } from '../../../support/harness/render';
import {
  advanceTimersByTimeAsync,
  restoreRealTimers,
  useFakeTimers,
} from '../../../support/harness/timers';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';
import { routerWithLinkStub } from '../../../support/mocks/router';

// One instance for the file: the real `useNavigate` is stable across renders,
// and a fresh mock per call would churn the memo this test is about.
const navigate = jest.fn();
void mock.module(
  '@tanstack/react-router',
  await routerWithLinkStub({ useNavigate: () => navigate })
);

const { useCommandRegistry } =
  await import('../../../../src/features/command-palette/use-command-registry');

type AppState = ReturnType<typeof useAppState>;

// Hoisted for the same reason the real ones are memoized on the shell: these
// stand in for query results, which keep their identity between renders.
const chats = [
  { id: 'c1', title: 'Plugin LSP', updatedAt: 1, runner: { kind: 'mangostudio' } },
] as unknown as Chat[];
const agents: AgentProfile[] = [];

/**
 * One render's worth of shell state. Deliberately rebuilt per call with the
 * same field values — that is exactly what a streamed token produces.
 */
function appState(chatPaging: ChatPaging = NO_MORE_CHATS): AppState {
  return {
    agents,
    chats,
    chatPaging,
    currentChatId: 'c1',
    currentEnvironmentId: null,
    runner: { kind: 'mangostudio', agentId: 'default' },
    handleSelectChat: jest.fn(),
    handleNewChat: jest.fn(),
    handleNewChatWithRunner: jest.fn(),
    openWorkdirPicker: jest.fn(),
    // The GitHub rows read the rail's own settings: hidden there, the rail
    // drops the panel and the rows would select a different one.
    settings: { workspaceSettings: DEFAULT_WORKSPACE_SETTINGS },
  } as unknown as AppState;
}

/** The registry hook's own context, since the shared harness owns the wrapper. */
function Probe({
  app,
  onRun,
  seen,
}: {
  app: AppState;
  onRun: () => void;
  seen: { items: readonly CommandItem[] };
}) {
  return (
    <AppContext value={app}>
      <Registry onRun={onRun} seen={seen} />
    </AppContext>
  );
}

function Registry({ onRun, seen }: { onRun: () => void; seen: { items: readonly CommandItem[] } }) {
  seen.items = useCommandRegistry(onRun).items;
  return null;
}

/**
 * Stands in for the GitHub panel having read the chat's pull request list: the
 * same query, so the palette finds the answer in the cache it shares.
 */
function PanelListRead({ chatId }: { chatId: string }) {
  useQuery(githubPrsQueryOptions(chatId, 'open'));
  return null;
}

/**
 * @param extra Rendered beside the registry, in the same query client, for a
 *   test that needs another component filling a cache the registry reads.
 * @param configure Registers further responses before anything renders.
 */
async function setup(
  extra: ReactNode = null,
  configure: (scenario: ReturnType<typeof createFetchScenario>) => void = () => undefined
) {
  const scenario = createFetchScenario();
  scenario.install();
  configure(scenario);
  scenario.respondWithJson('GET', '/api/environments', { body: [] });
  // The shell above has no environment, so discovery falls back to local — the
  // machine a new chat starts on. What matters is that the query runs at all:
  // a null id used to disable it and silently drop every vendor row.
  scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
    body: {
      agents: [
        {
          targetId: 'codex',
          environmentId: 'local',
          installed: true,
          authState: 'unknown',
          capabilities: {},
        },
      ],
    },
  });

  const seen: { items: readonly CommandItem[] } = { items: [] };
  const onRun = jest.fn();
  const { rerender } = render(
    <>
      <Probe app={appState()} onRun={onRun} seen={seen} />
      {extra}
    </>
  );
  // The environments query settles after the first render. Letting it land here
  // keeps the assertion about the shell object rather than about a cache fill.
  await flushAsyncRender();
  // Re-rendered through the same fragment: a bare `<Probe>` would be a different
  // element type at the root and remount the registry instead of updating it.
  const rerenderRegistry = (ui: ReactNode) =>
    rerender(
      <>
        {ui}
        {extra}
      </>
    );
  return { scenario, seen, onRun, rerender: rerenderRegistry };
}

describe('useCommandRegistry chat paging', () => {
  /** A paging handle that records asks and reports the state a test names. */
  function pagingWith(overrides: Partial<ChatPaging>) {
    const loadMore = jest.fn(() => Promise.resolve());
    const paging: ChatPaging = {
      hasMore: true,
      isLoadingMore: false,
      loadFailed: false,
      loadMore,
      ...overrides,
    };
    return { paging, loadMore };
  }

  it('reads the pages the shell has not loaded, so a session can be found by typing', async () => {
    const { paging, loadMore } = pagingWith({});
    const scenario = createFetchScenario();
    scenario.install();
    scenario.respondWithJson('GET', '/api/environments', { body: [] });
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { agents: [] },
    });
    const seen: { items: readonly CommandItem[] } = { items: [] };

    render(<Probe app={appState(paging)} onRun={jest.fn()} seen={seen} />);
    await flushAsyncRender();

    expect(
      loadMore.mock.calls.length,
      'expected the palette to ask for the next chat page while one remains'
    ).toBeGreaterThan(0);
    scenario.restore();
  });

  it('does not retry a page that failed, or ask while one is loading', async () => {
    const failed = pagingWith({ loadFailed: true });
    const loading = pagingWith({ isLoadingMore: true });
    const scenario = createFetchScenario();
    scenario.install();
    scenario.respondWithJson('GET', '/api/environments', { body: [] });
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { agents: [] },
    });
    const seen: { items: readonly CommandItem[] } = { items: [] };

    const { rerender } = render(
      <Probe app={appState(failed.paging)} onRun={jest.fn()} seen={seen} />
    );
    await flushAsyncRender();
    rerender(<Probe app={appState(loading.paging)} onRun={jest.fn()} seen={seen} />);
    await flushAsyncRender();

    expect(failed.loadMore).not.toHaveBeenCalled();
    expect(loading.loadMore).not.toHaveBeenCalled();
    scenario.restore();
  });
});

describe('useCommandRegistry', () => {
  it('rebuilds no rows when only the shell object identity changed', async () => {
    const { scenario, seen, onRun, rerender } = await setup();
    const first = seen.items;

    // A token lands: same chats, same agents, brand-new `app` and brand-new
    // handlers hanging off it.
    act(() => {
      rerender(<Probe app={appState()} onRun={onRun} seen={seen} />);
    });

    expect(seen.items).toBe(first);
    scenario.restore();
  });

  it('runs the handler the shell holds now, not the one opening captured', async () => {
    const { scenario, seen, onRun, rerender } = await setup();

    // The price of keeping the memo stable: rows close over a ref rather than
    // over the handler. A row must therefore still reach the *current* one.
    const replacement = appState();
    act(() => {
      rerender(<Probe app={replacement} onRun={onRun} seen={seen} />);
    });

    await seen.items.find((item) => item.id === 'session:c1')?.run();

    expect(replacement.handleSelectChat).toHaveBeenCalledWith('c1');
    expect(onRun).toHaveBeenCalledTimes(1);
    scenario.restore();
  });

  /**
   * Run from /settings, the row awaits `navigate()` and fires its requests
   * before the chat surface has committed the rail. A rail that subscribes
   * after the row finished still has to hear both the panel and the form.
   */
  it('hands the GitHub create request to a rail that mounts after the navigation', async () => {
    const { scenario, seen } = await setup();
    navigate.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 0)));

    await act(async () => {
      await seen.items.find((item) => item.id === 'action:github-create-pr')?.run();
    });

    const railPanel = jest.fn();
    const createForm = jest.fn();
    const unsubscribers = [onRailPanelRequest(railPanel), onGithubCreatePrRequest(createForm)];
    for (const unsubscribe of unsubscribers) unsubscribe();

    expect(railPanel).toHaveBeenCalledWith('github');
    expect(createForm).toHaveBeenCalledTimes(1);
    scenario.restore();
  });

  it('leaves no create-form latch behind when no rail mounts within the window', async () => {
    const { scenario, seen } = await setup();
    useFakeTimers();

    await act(async () => {
      await seen.items.find((item) => item.id === 'action:github-create-pr')?.run();
    });
    await advanceTimersByTimeAsync(RAIL_PANEL_REQUEST_WINDOW_MS);
    await restoreRealTimers();

    const railPanel = jest.fn();
    const createForm = jest.fn();
    const unsubscribers = [onRailPanelRequest(railPanel), onGithubCreatePrRequest(createForm)];
    for (const unsubscribe of unsubscribers) unsubscribe();

    expect(railPanel, 'rail panel request replayed after the window').not.toHaveBeenCalled();
    expect(createForm, 'create form latch replayed after the window').not.toHaveBeenCalled();
    scenario.restore();
  });

  /**
   * "Create pull request" runs the panel's create form, which the panel
   * withholds on a machine that refuses `gh` writes (`canMutate: false`). The
   * palette reads the panel's own answer from the query cache they share.
   */
  describe('Create pull request row on a machine that may refuse writes', () => {
    const PRS_PATH = '/api/github/prs?chatId=c1&filter=open';
    const CREATE_PR_ID = 'action:github-create-pr';

    function mountWithPanelRead(canMutate: boolean) {
      return setup(<PanelListRead chatId="c1" />, (scenario) => {
        scenario.respondWithJson('GET', PRS_PATH, {
          body: {
            state: 'ok',
            cachedAt: 1_000,
            canMutate,
            repo: { nameWithOwner: 'mango/studio', defaultBranch: 'main', url: 'https://x.test' },
            prs: [],
          },
        });
      });
    }

    it('hides the row once the panel has read that the machine refuses writes', async () => {
      const { scenario, seen } = await mountWithPanelRead(false);
      try {
        await waitFor(() => {
          expect(seen.items.map((item) => item.id)).not.toContain(CREATE_PR_ID);
        });
        // Only the write row goes; the rows that just open the panel stay.
        expect(seen.items.map((item) => item.id)).toContain('action:github-panel');
      } finally {
        scenario.restore();
      }
    });

    it('keeps the row when the panel has read that writes are allowed', async () => {
      const { scenario, seen } = await mountWithPanelRead(true);
      try {
        await waitFor(() => {
          expect(seen.items.map((item) => item.id)).toContain(CREATE_PR_ID);
        });
      } finally {
        scenario.restore();
      }
    });

    it('keeps the row, and reads nothing itself, before the panel has read the list', async () => {
      const { scenario, seen } = await setup();
      try {
        expect(seen.items.map((item) => item.id)).toContain(CREATE_PR_ID);
        const requested = scenario.fetchMock.mock.calls.map(([input]) =>
          input instanceof Request ? input.url : input.toString()
        );
        expect(
          requested.filter((url) => url.includes('/api/github/')),
          'GitHub requests made by opening the palette'
        ).toEqual([]);
      } finally {
        scenario.restore();
      }
    });
  });

  /**
   * `currentEnvironmentId` is null exactly when no chat exists, and a null id
   * disables the discovery query outright. Without the local fallback the
   * account with nothing but vendor CLIs to start from saw no "New chat
   * with …" rows until it had created an ordinary chat first.
   */
  it('discovers external runners on local when no chat names an environment', async () => {
    const { scenario, seen } = await setup();

    expect(seen.items.some((item) => item.id === 'action:new-chat-external:codex')).toBe(true);
    scenario.restore();
  });

  /**
   * The mutation key only exposes activity through `useIsMutating`, not
   * deduplication — a second `mutate()` while one is in flight starts a
   * second vendor subprocess. Reopening the palette while a refresh from the
   * header pill or the selector chip is still running must not offer the row
   * a second time.
   */
  it('omits the quota-refresh row while its mutation is still running', async () => {
    const scenario = createFetchScenario();
    scenario.install();
    scenario.respondWithJson('GET', '/api/environments', { body: [] });
    scenario.respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: {
        agents: [
          {
            targetId: 'codex',
            environmentId: 'local',
            installed: true,
            authState: 'unknown',
            capabilities: { accountUsage: true },
          },
        ],
      },
    });
    scenario.respondWithJson(
      'GET',
      '/api/external-agents/codex/account-limits?environmentId=local',
      {
        body: {},
      }
    );

    // Held open rather than resolved by `respondWithJson`, so the row's
    // absence can be checked while the request is genuinely still in flight.
    let resolveRefresh!: (response: Response) => void;
    const refreshGate = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const baseImplementation = scenario.fetchMock.getMockImplementation();
    if (!baseImplementation) throw new Error('fetch scenario has no base implementation');
    scenario.fetchMock.mockImplementation((input, init) => {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      if (
        method === 'POST' &&
        url.pathname === '/api/external-agents/codex/account-limits/refresh'
      ) {
        return refreshGate;
      }
      return baseImplementation(input, init);
    });

    const app = appState();
    app.runner = { kind: 'external', targetId: 'codex' } as AppState['runner'];
    const seen: { items: readonly CommandItem[] } = { items: [] };
    const onRun = jest.fn();
    render(<Probe app={app} onRun={onRun} seen={seen} />);
    await flushAsyncRender();

    const refreshRow = seen.items.find((item) => item.id === 'action:refresh-quota');
    expect(refreshRow).toBeTruthy();

    await act(async () => {
      await refreshRow?.run();
    });
    // `useIsMutating` announces the pending write through React Query's own
    // cache-change notification, a macrotask after `mutate()` starts.
    await flushAsyncRender();

    expect(seen.items.some((item) => item.id === 'action:refresh-quota')).toBe(false);

    await act(async () => {
      resolveRefresh(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await refreshGate;
    });
    // React Query settles a mutation, and reads `useIsMutating` off it, through
    // its own cache-change notification — a macrotask that a single flush is
    // not always enough clear of.
    await waitFor(() => {
      expect(seen.items.some((item) => item.id === 'action:refresh-quota')).toBe(true);
    });
    scenario.restore();
  });
});
