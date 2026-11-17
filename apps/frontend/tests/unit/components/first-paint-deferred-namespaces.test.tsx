/**
 * The first-paint chat route reads no deferred namespace.
 *
 * `settings` and `onboarding` are not in the entry chunk, so anything the chat
 * route renders before a settings page or the setup flow has loaded must come
 * from an eager namespace. This renders the chat surface (the page, the sidebar,
 * the header and its account menu) over a dictionary store whose deferred chunks
 * never arrive: a read of a deferred namespace would suspend and show the
 * fallback, or request a chunk, and either fails the test.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import type { Chat } from '@mangostudio/shared/chat';
import { en, ptBR } from '@mangostudio/shared/i18n';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense } from 'react';

import { setTestSession } from '../../support/setup/auth-client-stub';

const actualQueries = await import('../../../src/features/chat/queries');
const actualRouter = await import('@tanstack/react-router');

void mock.module('../../../src/features/chat/queries', () => ({
  ...actualQueries,
  useMessagesQuery: () => ({
    data: { pages: [{ messages: [], contextInfo: null }] },
    status: 'success',
  }),
}));

void mock.module('@tanstack/react-router', () => ({
  ...actualRouter,
  useNavigate: () => jest.fn(),
}));

// Stubs for the surfaces that need a router or the rail's own data; this file is about
// strings, not about what those panels show.
void mock.module('../../../src/features/workspace/rail/WorkspaceRail', () => ({
  WorkspaceRail: () => <div data-testid="workspace-rail" />,
}));
void mock.module('../../../src/features/chat/components/PinnedTodoPanel', () => ({
  PinnedTodoPanel: () => <div data-testid="pinned-todos" />,
}));
void mock.module('../../../src/features/home/WorkspaceHub', () => ({
  WorkspaceHub: () => <div data-testid="workspace-hub" />,
}));

const { ChatPage } = await import('../../../src/features/chat/ChatPage');
const { Header } = await import('../../../src/components/layout/Header');
const { Sidebar } = await import('../../../src/features/sidebar/components/Sidebar');
const { I18nProvider } = await import('../../../src/hooks/use-i18n');
const { DEFAULT_CONTEXT_SETTINGS } = await import('../../../src/hooks/use-global-settings');
const { createLocaleDictionaryStore } = await import('../../../src/lib/locale-dictionaries');
const { render } = await import('../../support/harness/render');
const { englishWithoutDeferredNamespaces } =
  await import('../../support/mocks/fake-locale-dictionaries');

/**
 * Both locales with no deferred namespace to be had: the English chunks fail the test
 * if asked for, and Portuguese is a dictionary without them. Asking is the bug.
 */
function createFirstPaintStore() {
  const requested: string[] = [];
  const refuse = (namespace: string) => () => {
    requested.push(namespace);
    return new Promise<never>(() => undefined);
  };
  const { settings: _settings, onboarding: _onboarding, ...portugueseCore } = ptBR;
  const store = createLocaleDictionaryStore({
    eager: { locale: 'en', messages: englishWithoutDeferredNamespaces },
    eagerNamespaces: { settings: refuse('settings'), onboarding: refuse('onboarding') },
    loaders: { 'pt-BR': () => Promise.resolve({ ...portugueseCore } as typeof ptBR) },
    onLoadError: () => undefined,
  });
  return { store, requested };
}

const CHAT = {
  id: 'chat-1',
  title: 'First paint',
  updatedAt: Date.now(),
  runner: { kind: 'mangostudio', agentId: 'default' },
  workdir: null,
} as unknown as Chat;

function ChatSurface() {
  return (
    <Suspense fallback={<p data-testid="first-paint-fallback">suspended</p>}>
      <Header
        currentPage="chat"
        onNewChat={jest.fn()}
        onNavigateToSettings={jest.fn()}
        onOpenCommandPalette={jest.fn()}
      />
      <Sidebar
        currentPage="chat"
        onNavigate={jest.fn()}
        chats={[CHAT]}
        currentChatId="chat-1"
        onSelectChat={jest.fn()}
        onUpdateChatTitle={jest.fn()}
        onDeleteChat={jest.fn()}
        onNewChat={jest.fn()}
      />
      <ChatPage
        chatId="chat-1"
        onSubmit={jest.fn()}
        disabled={false}
        isGenerating={false}
        onStop={jest.fn()}
        thinkingEnabled={false}
        reasoningEffort="medium"
        onThinkingToggle={jest.fn()}
        onReasoningEffortChange={jest.fn()}
        reasoningVisible={false}
        contextInfo={null}
        fallbackNotice={null}
        seedContextInfo={jest.fn()}
        contextSettings={DEFAULT_CONTEXT_SETTINGS}
        isContextActionPending={false}
        onCompactCurrentChat={jest.fn().mockResolvedValue(undefined)}
        onStartSummarizedChat={jest.fn().mockResolvedValue(undefined)}
        onResumeInterruptedTurn={jest.fn().mockResolvedValue(undefined)}
        onDismissInterruptedTurn={jest.fn().mockResolvedValue(undefined)}
        imageToolIntent={false}
        onImageToolIntentChange={jest.fn()}
        workspaceSettings={DEFAULT_WORKSPACE_SETTINGS}
      />
    </Suspense>
  );
}

beforeEach(() => {
  setTestSession({ user: { id: 'user-1', name: 'Taylor Tester' } });
  window.localStorage.setItem('mangostudio:locale', 'en');
});

describe('the first-paint chat route with no deferred namespace loaded', () => {
  it('renders in English, shows the Settings entry points, and requests no deferred chunk', async () => {
    const { store, requested } = createFirstPaintStore();

    render(
      <I18nProvider dictionaries={store}>
        <ChatSurface />
      </I18nProvider>
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId('account-menu-trigger'));

    expect(
      screen.queryByTestId('first-paint-fallback'),
      'expected the chat surface to render without suspending on a deferred namespace'
    ).toBeNull();
    // The sidebar button and the account menu item both come from `common.settings`.
    expect(screen.getAllByRole('button', { name: en.common.settings }).length).toBeGreaterThan(0);
    expect(screen.getByRole('menuitem', { name: en.common.settings })).toBeInTheDocument();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(
      requested,
      `expected deferred namespace chunk requests on first paint: none | received: ${requested.join(', ')}`
    ).toEqual([]);
  });

  it('renders in Portuguese from a dictionary that has no deferred namespace either', async () => {
    window.localStorage.setItem('mangostudio:locale', 'pt-BR');
    const { store, requested } = createFirstPaintStore();
    await store.load('pt-BR');

    render(
      <I18nProvider dictionaries={store}>
        <ChatSurface />
      </I18nProvider>
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId('account-menu-trigger'));

    expect(screen.queryByTestId('first-paint-fallback')).toBeNull();
    expect(screen.getByRole('menuitem', { name: ptBR.common.settings })).toBeInTheDocument();
    expect(requested).toEqual([]);
  });
});
