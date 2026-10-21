import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { requestRailPanel } from '../../../src/features/workspace/rail/rail-panel-request';
import { railCollapsedStorageKey } from '../../../src/features/workspace/rail/rail-state';
import { act, render, screen } from '../../support/harness/render';

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

/**
 * The slot the chat page's composer hands the rail below `lg`. A rail given none
 * draws no trigger, so the mobile tests need a real element to portal into.
 */
function mountTriggerSlot(): HTMLElement {
  const slot = document.createElement('span');
  slot.dataset.testSlot = '';
  document.body.appendChild(slot);
  return slot;
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
    for (const slot of document.querySelectorAll('[data-test-slot]')) slot.remove();
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

  // The current-item mark says "this panel is open". Folded down to the dock,
  // nothing is open, and a mark on whichever panel happened to be selected read
  // as a choice the person never made.
  it('marks the open panel in the dock, and no panel while the rail is collapsed', async () => {
    const user = userEvent.setup();
    renderRail();

    const repository = screen.getByRole('button', { name: 'Show Repository panel' });
    expect(repository).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Collapse agent side panel' }));

    for (const button of screen.getAllByRole('button', { name: /^Show .* panel$/ })) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
    expect(repository).not.toHaveClass('bg-fill-selected');

    // The icon the person presses next still opens that panel, and marks it.
    await user.click(repository);
    expect(screen.getByRole('button', { name: 'Show Repository panel' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
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
    renderRail({ triggerSlot: mountTriggerSlot() });

    expect(screen.queryByRole('dialog', { name: 'Agent side panel' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open agent side panel' }));
    expect(screen.getByRole('dialog', { name: 'Agent side panel' })).toBeVisible();
    expect(screen.getByTestId('git-panel-content')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Close agent side panel' }));
    expect(screen.queryByRole('dialog', { name: 'Agent side panel' })).not.toBeInTheDocument();
    // Closing hands focus back to the trigger that opened the drawer.
    expect(screen.getByRole('button', { name: 'Open agent side panel' })).toHaveFocus();
  });

  it('draws the mobile trigger into the composer slot, and nowhere else', () => {
    setDesktopMediaQuery(false);
    const slot = mountTriggerSlot();
    renderRail({ triggerSlot: slot });

    // A tool chip beside the composer's other controls: nothing floats over the
    // transcript, so the transcript keeps the composer's edges.
    const trigger = screen.getByRole('button', { name: 'Open agent side panel' });
    expect(slot).toContainElement(trigger);
    expect(trigger.className).toContain('composer-tool-chip');
    expect(trigger.className).not.toContain('absolute');
    expect(trigger.className).not.toContain('fixed');
  });

  it('draws no trigger below lg when the page offers no slot', () => {
    setDesktopMediaQuery(false);
    renderRail();

    expect(screen.queryByRole('button', { name: 'Open agent side panel' })).not.toBeInTheDocument();
  });

  /**
   * The command palette and the Repository panel's branch chip request a
   * panel through this same channel on desktop and mobile alike. On desktop
   * that only has to pick the panel; on mobile the rail is a drawer gated on
   * its own open state, so the request has to open that too or the picked
   * panel renders behind a closed drawer nobody sees.
   */
  it('opens the mobile drawer for a panel requested from outside the rail', () => {
    setDesktopMediaQuery(false);
    renderRail();

    expect(screen.queryByRole('dialog', { name: 'Agent side panel' })).not.toBeInTheDocument();
    act(() => {
      requestRailPanel('github');
    });

    expect(screen.getByRole('dialog', { name: 'Agent side panel' })).toBeVisible();
    expect(screen.getByTestId('github-panel-content')).toBeVisible();
  });
});
