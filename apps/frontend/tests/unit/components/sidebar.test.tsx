/**
 * The overhauled sidebar: date groups, harness badges, search, and the
 * behaviors that must survive the rebuild — rename, delete, new chat.
 *
 * Fixtures are placed relative to a local noon anchor so a run at 00:30 or
 * 23:59 still lands each chat in the bucket the assertion names.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { Sidebar } from '../../../src/features/sidebar/components/Sidebar';
import { flushAsyncRender, render } from '../../support/harness/render';

// Today at noon: stable "today" regardless of when the lane runs.
const todayNoon = new Date();
todayNoon.setHours(12, 0, 0, 0);
const DAY_MS = 86_400_000;

function chatFixture(
  id: string,
  title: string,
  updatedAt: number,
  runner: Chat['runner'],
  workdir: string | null = null
): Chat {
  return { id, title, updatedAt, runner, workdir } as unknown as Chat;
}

const CHATS = [
  chatFixture(
    'c1',
    'Plugin LSP TypeScript',
    todayNoon.getTime(),
    { kind: 'external', targetId: 'codex' },
    '/home/u/projects/mango-lsp-store'
  ),
  chatFixture('c2', 'sse-soak load test', todayNoon.getTime() - DAY_MS, {
    kind: 'mangostudio',
    agentId: 'default',
  } as Chat['runner']),
  chatFixture('c3', 'Ancient refactor', todayNoon.getTime() - 70 * DAY_MS, {
    kind: 'external',
    targetId: 'claude',
  }),
];

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const props = {
    currentPage: 'chat' as const,
    onNavigate: jest.fn(),
    chats: CHATS,
    currentChatId: 'c1',
    onSelectChat: jest.fn(),
    onUpdateChatTitle: jest.fn(),
    onDeleteChat: jest.fn(),
    onNewChat: jest.fn(),
    ...overrides,
  };
  const result = render(<Sidebar {...props} />);
  return { ...result, props };
}

beforeEach(() => {
  window.localStorage.setItem('mangostudio:locale', 'en');
});

afterEach(() => {
  window.localStorage.clear();
});

describe('sidebar grouping', () => {
  it('renders one dated group per bucket, in list order', () => {
    renderSidebar();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    const oldMonth = new Intl.DateTimeFormat('en', { month: 'long' }).format(
      new Date(todayNoon.getTime() - 70 * DAY_MS)
    );
    expect(screen.getByText(new RegExp(oldMonth))).toBeInTheDocument();
  });

  it('attributes each row to its harness', () => {
    renderSidebar();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('mango')).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
  });
});

describe('sidebar git badges', () => {
  const GIT_SUMMARIES = {
    c1: {
      branch: 'feat/lsp-store',
      ahead: 2,
      behind: 1,
      changedFileCount: 3,
      workdir: '/home/u/projects/mango-lsp-store',
    },
    c2: {
      branch: null,
      detachedAt: 'abc1234def5678',
      ahead: 0,
      behind: 0,
      changedFileCount: 0,
      workdir: '/home/u/projects/soak',
    },
    c3: null,
  };

  function rowFor(title: string): HTMLElement {
    const row = screen.getByText(title).closest('li');
    if (!row) throw new Error('row not found');
    return row;
  }

  it('shows branch, dirty dot, and sync drift from the batched summary', () => {
    renderSidebar({ gitSummaries: GIT_SUMMARIES });
    const row = rowFor('Plugin LSP TypeScript');
    expect(within(row).getByText('feat/lsp-store')).toBeInTheDocument();
    expect(within(row).getByTitle('3 uncommitted changes')).toBeInTheDocument();
    expect(within(row).getByText('↑2 ↓1')).toBeInTheDocument();
  });

  it('falls back to the short detached hash and hides clean/synced indicators', () => {
    renderSidebar({ gitSummaries: GIT_SUMMARIES });
    const row = rowFor('sse-soak load test');
    expect(within(row).getByText('abc1234')).toBeInTheDocument();
    expect(within(row).queryByTitle(/uncommitted/)).toBeNull();
    expect(within(row).queryByText(/↑/)).toBeNull();
  });

  it('renders no badge for a chat the server has no answer for', () => {
    renderSidebar({ gitSummaries: GIT_SUMMARIES });
    expect(within(rowFor('Ancient refactor')).queryByTestId('git-summary-badge')).toBeNull();
  });

  it('renders no badges at all without summaries', () => {
    renderSidebar();
    expect(screen.queryByTestId('git-summary-badge')).toBeNull();
  });

  it('keeps the badge out of the chat-selection button accessible name', () => {
    renderSidebar({ gitSummaries: GIT_SUMMARIES });
    const row = rowFor('Plugin LSP TypeScript');
    const select = within(row).getByRole('button', { name: 'Plugin LSP TypeScript' });
    expect(select).not.toContainElement(within(row).getByTestId('git-summary-badge'));
  });
});

describe('sidebar search', () => {
  it('filters by title and drops emptied groups', async () => {
    renderSidebar();
    fireEvent.change(screen.getByLabelText('Search chats…'), { target: { value: 'sse' } });
    await flushAsyncRender();
    expect(screen.getByText('sse-soak load test')).toBeInTheDocument();
    expect(screen.queryByText('Plugin LSP TypeScript')).toBeNull();
    expect(screen.queryByText('Today')).toBeNull();
  });

  it('filters by workdir basename and by runner label', async () => {
    renderSidebar();
    const input = screen.getByLabelText('Search chats…');
    fireEvent.change(input, { target: { value: 'lsp-store' } });
    await flushAsyncRender();
    expect(screen.getByText('Plugin LSP TypeScript')).toBeInTheDocument();
    expect(screen.queryByText('Ancient refactor')).toBeNull();

    fireEvent.change(input, { target: { value: 'claude' } });
    await flushAsyncRender();
    expect(screen.getByText('Ancient refactor')).toBeInTheDocument();
    expect(screen.queryByText('sse-soak load test')).toBeNull();
  });

  it('shows the empty state for a query nothing matches', async () => {
    renderSidebar();
    fireEvent.change(screen.getByLabelText('Search chats…'), { target: { value: 'zzz' } });
    await flushAsyncRender();
    expect(screen.getByText('No results for "zzz"')).toBeInTheDocument();
  });

  it('clears on Escape', async () => {
    renderSidebar();
    const input = screen.getByLabelText<HTMLInputElement>('Search chats…');
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await flushAsyncRender();
    expect(input.value).toBe('');
    expect(screen.getByText('Plugin LSP TypeScript')).toBeInTheDocument();
  });
});

describe('sidebar behaviors that must survive the overhaul', () => {
  it('starts a new chat from the CTA, whose accessible name stays clean of the shortcut', () => {
    const { props } = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
    expect(props.onNewChat).toHaveBeenCalledTimes(1);
  });

  it('selects a chat on row click', () => {
    const { props } = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'sse-soak load test' }));
    expect(props.onSelectChat).toHaveBeenCalledWith('c2');
  });

  /**
   * `role="button"` makes every descendant presentational, so rename and delete
   * would lose their role and name to assistive tech if they lived inside the
   * control that selects the chat. They are siblings of it, not children.
   */
  it('keeps the row actions outside the chat-selection button', () => {
    renderSidebar();
    const row = screen.getByText('Plugin LSP TypeScript').closest('li');
    if (!row) throw new Error('row not found');
    const select = within(row).getByRole('button', { name: 'Plugin LSP TypeScript' });
    expect(select).not.toContainElement(within(row).getByTitle('Edit title'));
    expect(select).not.toContainElement(within(row).getByTitle('Delete chat'));
    expect(row.querySelector('[role="button"]')).toBeNull();
  });

  it('puts the inline editor beside the row actions, not inside a button', () => {
    renderSidebar();
    const row = screen.getByText('Plugin LSP TypeScript').closest('li');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row).getByTitle('Edit title'));
    const editor = screen.getByDisplayValue<HTMLInputElement>('Plugin LSP TypeScript');
    expect(editor.closest('button')).toBeNull();
    expect(editor.closest('[role="button"]')).toBeNull();
  });

  it('renames through the inline editor', () => {
    const { props } = renderSidebar();
    const row = screen.getByText('Plugin LSP TypeScript').closest('li');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row as HTMLElement).getByTitle('Edit title'));
    const editor = screen.getByDisplayValue<HTMLInputElement>('Plugin LSP TypeScript');
    fireEvent.change(editor, { target: { value: 'Renamed' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(props.onUpdateChatTitle).toHaveBeenCalledWith('c1', 'Renamed');
  });

  it('deletes from the row action', () => {
    const { props } = renderSidebar();
    const row = screen.getByText('Ancient refactor').closest('li');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row as HTMLElement).getByTitle('Delete chat'));
    expect(props.onDeleteChat).toHaveBeenCalledWith('c3');
  });

  it('does not let Enter/Space on the edit or delete buttons activate the row', () => {
    const { props } = renderSidebar();
    const row = screen.getByText('Plugin LSP TypeScript').closest('li');
    if (!row) throw new Error('row not found');
    fireEvent.keyDown(within(row as HTMLElement).getByTitle('Edit title'), { key: 'Enter' });
    fireEvent.keyDown(within(row as HTMLElement).getByTitle('Delete chat'), { key: ' ' });
    expect(props.onSelectChat).not.toHaveBeenCalled();
  });

  it('does not let a space in the inline editor activate the row', () => {
    const { props } = renderSidebar();
    const row = screen.getByText('Plugin LSP TypeScript').closest('li');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row as HTMLElement).getByTitle('Edit title'));
    const editor = screen.getByDisplayValue<HTMLInputElement>('Plugin LSP TypeScript');
    fireEvent.keyDown(editor, { key: ' ' });
    expect(props.onSelectChat).not.toHaveBeenCalled();
  });

  it('exposes chat titles through the title attribute when truncated', () => {
    renderSidebar();
    expect(screen.getByText('Ancient refactor')).toHaveAttribute('title', 'Ancient refactor');
  });
});

/**
 * The shell around the session list. None of it moved in the overhaul, which is
 * exactly why it is asserted here: the rewrite of the list is the change most
 * likely to take the nav, the resize handle or the mobile slide-over with it.
 */
describe('sidebar shell', () => {
  it('renders navigation items for all top-level pages', () => {
    renderSidebar();
    expect(screen.getAllByRole('button', { name: /studio/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /gallery/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /settings/i }).length).toBeGreaterThanOrEqual(1);
  });

  // The library lives under the environments umbrella now, so a Library entry
  // here would be a second way in to a surface that already has one.
  it('offers no standalone Library entry', () => {
    renderSidebar();
    expect(screen.queryByRole('button', { name: /library/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: /environments/i }).length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('highlights Studio when it is the current page', () => {
    renderSidebar({ currentPage: 'studio' });
    const studioButtons = screen.getAllByRole('button', { name: /studio/i });
    expect(studioButtons[0]?.className).toContain('text-primary');
  });

  it('calls onNavigate with "studio" when Studio is clicked', () => {
    const { props } = renderSidebar();
    fireEvent.click(screen.getAllByRole('button', { name: /studio/i })[0] as HTMLElement);
    expect(props.onNavigate).toHaveBeenCalledWith('studio');
  });

  it('mobile shortcuts close the sidebar after navigation', () => {
    const onMobileClose = jest.fn();
    const { props } = renderSidebar({ onMobileClose });
    const shortcuts = screen.getByTestId('mobile-shortcuts');
    fireEvent.click(within(shortcuts).getByRole('button', { name: /studio/i }));
    expect(props.onNavigate).toHaveBeenCalledWith('studio');
    expect(onMobileClose).toHaveBeenCalled();
  });

  it('is visible on mobile when isMobileOpen is true', () => {
    const { container } = renderSidebar({ isMobileOpen: true });
    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('flex');
    expect(aside?.className).not.toContain('hidden');
  });

  it('is hidden on mobile when isMobileOpen is false', () => {
    const { container } = renderSidebar({ isMobileOpen: false });
    expect(container.querySelector('aside')?.className).toContain('hidden');
  });

  it('resizes from the keyboard and persists the clamped width', () => {
    const onWidthChange = jest.fn();
    const { container } = renderSidebar({ width: 256, onWidthChange });
    const handle = screen.getByRole('separator', { name: /resize chat sidebar/i });
    expect(handle).toHaveAttribute('aria-valuenow', '256');
    // `h-auto` overrides the preflight `hr { height: 0 }`; without it the handle is unhittable.
    expect(handle).toHaveClass('h-auto');
    expect(handle.nextElementSibling).toHaveClass('bg-outline-variant/50');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyUp(handle, { key: 'ArrowRight' });
    expect(onWidthChange).toHaveBeenCalledWith(272);
    expect(container.querySelector('aside')).toHaveStyle({ width: '272px' });
  });

  // The rail handle sits on the opposite edge, so a shared component that mixed
  // the two directions up would still pass the rail's drag test.
  it('grows the sidebar when its right-edge handle is dragged right', () => {
    const onWidthPreview = jest.fn();
    const { container } = renderSidebar({
      width: 256,
      onWidthPreview,
      onWidthChange: jest.fn(),
    });
    const handle = screen.getByRole('separator', { name: /resize chat sidebar/i });

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 256 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 296 });

    expect(onWidthPreview).toHaveBeenLastCalledWith(296);
    expect(container.querySelector('aside')).toHaveStyle({ width: '296px' });
  });
});
