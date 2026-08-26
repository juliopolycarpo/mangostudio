import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { railCollapsedStorageKey } from '../../../src/features/workspace/rail/rail-state';
import { render, screen } from '../../support/harness/render';

const mocks = {
  todos: [
    {
      content: 'Verify the workspace rail',
      status: 'in_progress' as const,
    },
  ],
};

mock.module('../../../src/features/chat/hooks/use-chat-todos', () => ({
  useChatTodos: () => ({ data: { todos: mocks.todos, updatedAt: Date.now() } }),
}));

// Declared at module level rather than inline in the factory: biome's
// `noComponentHookFactories` rejects a component defined inside a function.
function GitPanelStub({ chatId }: { chatId: string }) {
  return <div data-testid="git-panel-content">{chatId}</div>;
}

mock.module('../../../src/features/workspace/GitPanel', () => ({ GitPanel: GitPanelStub }));

// Stubbed for the same reason as the Git panel: the registry imports it
// eagerly, so without this every rail test would mount the real GitHub panel
// and its queries just to click between dock buttons.
function GithubPanelStub({ chatId }: { chatId: string }) {
  return <div data-testid="github-panel-content">{chatId}</div>;
}

mock.module('../../../src/features/github/components/GithubPanel', () => ({
  GithubPanel: GithubPanelStub,
}));

// Below the mocks, never as a static import: those are evaluated first and the
// rail would bind the real todo hook and the real git panel.
const { WorkspaceRail } = await import('../../../src/features/workspace/rail/WorkspaceRail');

/**
 * `vi.stubGlobal` / `vi.unstubAllGlobals` have no `bun test` equivalent, so the
 * harness's own `matchMedia` is captured once and put back in `afterEach`.
 */
const harnessMatchMedia = globalThis.matchMedia;

function setDesktopMediaQuery(matches: boolean) {
  globalThis.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof globalThis.matchMedia;
}

function renderRail(overrides: Partial<React.ComponentProps<typeof WorkspaceRail>> = {}) {
  return render(
    <WorkspaceRail
      chatId="chat-1"
      workdir="/srv/projects/mango"
      settings={DEFAULT_WORKSPACE_SETTINGS.sidePanel}
      {...overrides}
    />
  );
}

describe('WorkspaceRail', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setDesktopMediaQuery(true);
  });

  afterEach(() => {
    globalThis.matchMedia = harnessMatchMedia;
  });

  it('switches registry panels in configured order', async () => {
    const user = userEvent.setup();
    renderRail({
      settings: {
        ...DEFAULT_WORKSPACE_SETTINGS.sidePanel,
        panelOrder: ['todos', 'git'],
      },
    });

    expect(screen.getByText('Verify the workspace rail')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show Repository panel' }));
    expect(screen.getByTestId('git-panel-content')).toHaveTextContent('chat-1');
  });

  it('remembers the collapsed state per chat', async () => {
    const user = userEvent.setup();
    const view = renderRail();

    await user.click(screen.getByRole('button', { name: 'Collapse agent side panel' }));
    expect(screen.queryByTestId('git-panel-content')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(railCollapsedStorageKey('chat-1'))).toBe('true');

    view.unmount();
    renderRail();
    expect(screen.queryByTestId('git-panel-content')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show Repository panel' }));
    expect(screen.getByTestId('git-panel-content')).toBeVisible();
    expect(window.localStorage.getItem(railCollapsedStorageKey('chat-1'))).toBeNull();
  });

  it('resizes from the keyboard and persists the clamped width', async () => {
    const user = userEvent.setup();
    const onWidthChange = jest.fn();
    renderRail({ onWidthChange });

    await user.type(
      screen.getByRole('separator', { name: 'Resize agent side panel' }),
      '{ArrowLeft}'
    );
    expect(onWidthChange).toHaveBeenCalledWith(376);
  });

  it('stops tracking the pointer once a drag is cancelled', () => {
    const onWidthChange = jest.fn();
    renderRail({ onWidthChange });
    const handle = screen.getByRole('separator', { name: 'Resize agent side panel' });

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 460 });
    expect(handle).toHaveAttribute('aria-valuenow', '400');

    fireEvent.pointerCancel(handle, { pointerId: 1 });
    // `toHaveBeenCalledExactlyOnceWith` is a Vitest matcher `bun test` does not
    // have; the pair below asserts the same thing.
    expect(onWidthChange).toHaveBeenCalledTimes(1);
    expect(onWidthChange).toHaveBeenCalledWith(400);

    // Merely hovering the handle afterwards must not keep resizing the rail.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300 });
    expect(handle).toHaveAttribute('aria-valuenow', '400');
  });

  it('opens the same panels in a mobile slide-over', async () => {
    const user = userEvent.setup();
    setDesktopMediaQuery(false);
    renderRail();

    expect(screen.queryByRole('dialog', { name: 'Agent side panel' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open agent side panel' }));
    expect(screen.getByRole('dialog', { name: 'Agent side panel' })).toBeVisible();
    expect(screen.getByTestId('git-panel-content')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Close agent side panel' }));
    expect(screen.queryByRole('dialog', { name: 'Agent side panel' })).not.toBeInTheDocument();
  });
});
