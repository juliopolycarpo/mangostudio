import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';

import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import { screen } from '@testing-library/react';

import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';
import { setTestSession } from '../../support/setup/auth-client-stub';

const actualQueries = await import('../../../src/features/chat/queries');

void mock.module('../../../src/features/chat/queries', () => ({
  ...actualQueries,
  useMessagesQuery: () => ({
    data: { pages: [{ messages: [], contextInfo: null }] },
    status: 'success',
  }),
}));

// This file is about when the folder picker's chunk is fetched, not about what
// the rail, the todo panel or the empty-state hub draw, so those are stubbed
// the way `chat-page-context-warning.test.tsx` stubs them.
void mock.module('../../../src/features/workspace/rail/WorkspaceRail', () => ({
  WorkspaceRail: () => <div data-testid="workspace-rail" />,
}));
void mock.module('../../../src/features/chat/components/PinnedTodoPanel', () => ({
  PinnedTodoPanel: () => <div data-testid="pinned-todos" />,
}));
void mock.module('../../../src/features/home/WorkspaceHub', () => ({
  WorkspaceHub: () => <div data-testid="workspace-hub" />,
}));

// After the mocks, never before: a static import is evaluated first and would
// bind ChatPage to the real queries and rail components.
const { ChatPage } = await import('../../../src/features/chat/ChatPage');
const { lazyWorkdirPickerDialog } =
  await import('../../../src/features/workspace/LazyWorkdirPickerDialog');
const { DEFAULT_CONTEXT_SETTINGS } = await import('../../../src/hooks/use-global-settings');
const { act, render } = await import('../../support/harness/render');

const FS_LISTING = {
  path: '/srv/projects',
  parent: '/srv',
  entries: [],
  home: '/home/mango',
  roots: ['/'],
  separator: '/',
};

function renderChatPage(overrides: Partial<React.ComponentProps<typeof ChatPage>> = {}) {
  const props: React.ComponentProps<typeof ChatPage> = {
    chatId: 'chat-1',
    onSubmit: jest.fn(),
    disabled: false,
    isGenerating: false,
    onStop: jest.fn(),
    thinkingEnabled: false,
    reasoningEffort: 'medium',
    onThinkingToggle: jest.fn(),
    onReasoningEffortChange: jest.fn(),
    reasoningVisible: false,
    contextInfo: null,
    fallbackNotice: null,
    seedContextInfo: jest.fn(),
    contextSettings: DEFAULT_CONTEXT_SETTINGS,
    isContextActionPending: false,
    onCompactCurrentChat: jest.fn().mockResolvedValue(undefined),
    onStartSummarizedChat: jest.fn().mockResolvedValue(undefined),
    onResumeInterruptedTurn: jest.fn().mockResolvedValue(undefined),
    onDismissInterruptedTurn: jest.fn().mockResolvedValue(undefined),
    imageToolIntent: false,
    onImageToolIntentChange: jest.fn(),
    workspaceSettings: DEFAULT_WORKSPACE_SETTINGS,
    onCloseWorkdirPicker: jest.fn(),
    onSelectWorkdir: jest.fn(),
    ...overrides,
  };
  return { ...render(<ChatPage {...props} />), props };
}

describe('ChatPage folder picker', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    window.localStorage.setItem('mangostudio:locale', 'en');
    setTestSession({ user: { id: 'user-1', name: 'Taylor Tester' } });
    fetchScenario.install();
    fetchScenario.respondWithJson('GET', '/api/workspace/fs?chatId=chat-1', { body: FS_LISTING });
    fetchScenario.respondWithJson('GET', '/api/workspace/fs?path=%2Fsrv%2Fprojects&chatId=chat-1', {
      body: FS_LISTING,
    });
  });

  afterEach(() => {
    fetchScenario.restore();
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it('draws no picker while it is closed', () => {
    renderChatPage({ isWorkdirPickerOpen: false });

    expect(
      screen.queryByRole('dialog'),
      'expected no dialog while isWorkdirPickerOpen is false | received a dialog'
    ).toBeNull();
  });

  it('draws the picker once its chunk arrives, when it is open', async () => {
    // Rendered and settled inside `act`: the chunk arrives and the dialog's
    // directory listing resolves after the synchronous render, and updates
    // outside `act` print a warning on a green test.
    await act(async () => {
      renderChatPage({ isWorkdirPickerOpen: true, workdir: '/srv/projects' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(
      screen.getByRole('dialog'),
      'expected the folder picker dialog to appear after the lazy chunk loads'
    ).toBeDefined();
  });

  it('asks for the picker chunk at once for a chat with no folder, which opens it on its own', () => {
    const preload = spyOn(lazyWorkdirPickerDialog, 'preload');

    renderChatPage({ workdir: null });

    expect(
      preload.mock.calls.length,
      'expected one immediate preload for a chat with no folder'
    ).toBe(1);
  });

  it('leaves the picker chunk to the idle warm-up for a chat that already has a folder', () => {
    const preload = spyOn(lazyWorkdirPickerDialog, 'preload');

    renderChatPage({ workdir: '/srv/projects' });

    // The idle callback is scheduled, not run, inside this synchronous render.
    expect(
      preload.mock.calls.length,
      'expected no immediate preload for a chat with a folder | received a synchronous call'
    ).toBe(0);
  });
});
