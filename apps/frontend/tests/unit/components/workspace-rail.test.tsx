import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { railCollapsedStorageKey } from '../../../src/features/workspace/rail/rail-state';
import { WorkspaceRail } from '../../../src/features/workspace/rail/WorkspaceRail';
import { render, screen } from '../../support/harness/render';

const mocks = vi.hoisted(() => ({
  todos: [
    {
      content: 'Verify the workspace rail',
      status: 'in_progress' as const,
    },
  ],
}));

vi.mock('../../../src/features/chat/hooks/use-chat-todos', () => ({
  useChatTodos: () => ({ data: { todos: mocks.todos, updatedAt: Date.now() } }),
}));

vi.mock('../../../src/features/workspace/GitPanel', () => ({
  GitPanel: ({ chatId }: { chatId: string }) => <div data-testid="git-panel-content">{chatId}</div>,
}));

function setDesktopMediaQuery(matches: boolean) {
  // Stubbed rather than assigned so the shared harness `matchMedia` is restored after this file.
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

function renderRail(overrides: Partial<React.ComponentProps<typeof WorkspaceRail>> = {}) {
  return render(
    <WorkspaceRail
      chatId="chat-1"
      agentExecutionMode="agent"
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
    vi.unstubAllGlobals();
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
    const onWidthChange = vi.fn();
    renderRail({ onWidthChange });

    await user.type(
      screen.getByRole('separator', { name: 'Resize agent side panel' }),
      '{ArrowLeft}'
    );
    expect(onWidthChange).toHaveBeenCalledWith(376);
  });

  it('stops tracking the pointer once a drag is cancelled', () => {
    const onWidthChange = vi.fn();
    renderRail({ onWidthChange });
    const handle = screen.getByRole('separator', { name: 'Resize agent side panel' });

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 460 });
    expect(handle).toHaveAttribute('aria-valuenow', '400');

    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(onWidthChange).toHaveBeenCalledExactlyOnceWith(400);

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
