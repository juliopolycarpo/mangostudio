/**
 * The overhauled sidebar: date groups, harness badges, search, and the
 * behaviors that must survive the rebuild — rename, delete, new chat.
 *
 * Fixtures are placed relative to a local noon anchor so a run at 00:30 or
 * 23:59 still lands each chat in the bucket the assertion names.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import type { Chat } from '@mangostudio/shared/chat';
import { en } from '@mangostudio/shared/i18n';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

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

describe('sidebar chat row leading slot', () => {
  const RING_INFO = {
    estimatedInputTokens: 62_000,
    contextLimit: 100_000,
    estimatedUsageRatio: 0.62,
    mode: 'stateful',
    severity: 'normal',
  } as const;

  /** The slot is the `aria-hidden` box that precedes the title inside the select button. */
  function slotFor(title: string): HTMLElement {
    const slot = screen.getByText(title).previousElementSibling;
    if (!(slot instanceof HTMLElement)) throw new Error('leading slot not found');
    return slot;
  }

  it('gives the context ring and the plain chat icon the same 20px box, so titles share one x', () => {
    renderSidebar({ contextCache: new Map([['c1', RING_INFO]]) });

    const withRing = slotFor('Plugin LSP TypeScript');
    const withIcon = slotFor('sse-soak load test');
    expect(withRing.querySelector('svg')).not.toHaveClass('lucide-message-square');
    expect(withIcon.querySelector('svg')).toHaveClass('lucide-message-square');
    for (const slot of [withRing, withIcon]) {
      expect(slot).toHaveClass('size-5', 'shrink-0', 'justify-center');
    }
  });

  it('keeps the same slot in the inline rename editor', () => {
    renderSidebar({ contextCache: new Map([['c1', RING_INFO]]) });
    const row = screen.getByText('Plugin LSP TypeScript').closest('li');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row).getByTitle('Edit title'));

    const editor = screen.getByDisplayValue<HTMLInputElement>('Plugin LSP TypeScript');
    expect(editor.previousElementSibling).toHaveClass('size-5', 'justify-center');
    // The field takes back its own padding, so the name does not step right.
    expect(editor).toHaveClass('-ml-2', 'px-2');
  });

  it('opens the rename field with the whole name selected and its start in view', () => {
    renderSidebar();
    const row = screen.getByText('Plugin LSP TypeScript').closest('li');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row).getByTitle('Edit title'));

    const editor = screen.getByDisplayValue<HTMLInputElement>('Plugin LSP TypeScript');
    expect(editor).toHaveFocus();
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe('Plugin LSP TypeScript'.length);
    expect(editor.selectionDirection).toBe('backward');
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

  function badgeFor(title: string, width?: number): HTMLElement {
    renderSidebar({ gitSummaries: GIT_SUMMARIES, ...(width ? { width } : {}) });
    return within(rowFor(title)).getByTestId('git-summary-badge');
  }

  it('is a glyph at the default width, with every fact in words for the tooltip and assistive tech', () => {
    const badge = badgeFor('Plugin LSP TypeScript');
    const description = 'feat/lsp-store · 3 uncommitted changes · 2 ahead, 1 behind';
    expect(badge).toHaveAttribute('title', description);
    // Read once, in full…
    expect(within(badge).getByText(description)).toHaveClass('sr-only');
    // …and not drawn: a label squeezed to "c…" says nothing and costs the title room.
    expect(within(badge).queryByText('feat/lsp-store')).toBeNull();
    expect(within(badge).queryByText('↑2 ↓1')).toBeNull();
  });

  it('marks a dirty tree with its own glyph in the warning hue, not a dot beside the runner dot', () => {
    const dirty = badgeFor('Plugin LSP TypeScript');
    expect(dirty.querySelector('svg')).toHaveClass('text-warning');
    expect(dirty.querySelector('svg')).toHaveClass('lucide-git-branch-plus');
    expect(dirty.querySelector('[data-tone]')).toBeNull();
    expect(within(rowFor('Plugin LSP TypeScript')).getAllByText('codex')).toHaveLength(1);
  });

  it('adds the branch and the drift once the sidebar is wide enough to read them', () => {
    const badge = badgeFor('Plugin LSP TypeScript', 320);
    expect(within(badge).getByText('feat/lsp-store')).toBeInTheDocument();
    expect(within(badge).getByText('↑2 ↓1')).toBeInTheDocument();
    // What is drawn is hidden from assistive tech: the sr-only sentence says it all.
    expect(within(badge).getByText('feat/lsp-store')).toHaveAttribute('aria-hidden', 'true');
  });

  it('falls back to the short detached hash and draws a clean, synced tree as a plain glyph', () => {
    const badge = badgeFor('sse-soak load test', 320);
    expect(within(badge).getAllByText('abc1234').length).toBeGreaterThan(0);
    expect(badge).toHaveAttribute('title', 'abc1234');
    expect(badge.querySelector('svg')).not.toHaveClass('text-warning');
    expect(badge.querySelector('svg')).toHaveClass('lucide-git-branch');
    expect(within(badge).queryByText(/↑/)).toBeNull();
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
    // Typographic quotes, as the delete dialog quotes a chat's name.
    expect(screen.getByText('No results for “zzz”')).toBeInTheDocument();
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

  it('offers a clear button while there is a query, which empties it and returns focus', async () => {
    renderSidebar();
    const input = screen.getByLabelText<HTMLInputElement>('Search chats…');
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'zzz' } });
    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(clear).toHaveAttribute('title', 'Clear search');
    // The query never runs under the button.
    expect(input).toHaveClass('pr-8');

    fireEvent.click(clear);
    await flushAsyncRender();
    expect(input.value).toBe('');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    expect(screen.getByText('Plugin LSP TypeScript')).toBeInTheDocument();
  });
});

describe('sidebar behaviors that must survive the overhaul', () => {
  it('starts a new chat from the CTA, whose accessible name stays clean of the shortcut', () => {
    const { props } = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
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

  // A chat nobody has named is stored as "New Chat [2026-10-21 14:24]", which a
  // row truncated to "New Chat [2026-10-…". It reads as the reader's word for an
  // untitled chat, and keeping that word in the editor is not a rename: storing
  // it would stop the first prompt from naming the chat.
  it('shows an untitled chat by name, and saving that name unchanged renames nothing', () => {
    const untitled = chatFixture('c0', 'New Chat [2026-10-21 14:24]', todayNoon.getTime(), {
      kind: 'mangostudio',
      agentId: 'default',
    } as Chat['runner']);
    const { props } = renderSidebar({ chats: [untitled, ...CHATS], currentChatId: 'c0' });
    expect(screen.queryByText(/\[2026-10-21/)).toBeNull();
    // The row's title span, not the "New chat" button that shares the word.
    const label = screen
      .getAllByText(en.chat.untitled)
      .find((element) => element.getAttribute('title') === en.chat.untitled);
    const row = label?.closest('li');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row).getByTitle('Edit title'));
    const editor = screen.getByDisplayValue<HTMLInputElement>(en.chat.untitled);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(props.onUpdateChatTitle).not.toHaveBeenCalled();
  });

  it('names the icon-only row actions and draws delete as a quiet destructive button', () => {
    renderSidebar();
    const row = screen.getByText('Plugin LSP TypeScript').closest('li') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Edit title' })).toBeInTheDocument();
    const remove = within(row).getByRole('button', { name: 'Delete chat' });
    expect(remove).toHaveClass('not-disabled:focus-visible:bg-danger-subtle');
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

describe('deleting a chat', () => {
  function openDeleteFor(title: string): HTMLElement {
    const row = screen.getByText(title).closest('li');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row).getByTitle('Delete chat'));
    return screen.getByRole('dialog', { name: 'Delete this chat?' });
  }

  it('asks first, naming the chat, and deletes nothing until it is confirmed', () => {
    const { props } = renderSidebar();
    const dialog = openDeleteFor('Ancient refactor');
    expect(within(dialog).getByText(/Ancient refactor/)).toBeInTheDocument();
    expect(props.onDeleteChat).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(props.onDeleteChat).not.toHaveBeenCalled();
  });

  it('puts the dialog outside the sliding panel, whose transform would capture it', () => {
    const { container } = renderSidebar();
    const dialog = openDeleteFor('Ancient refactor');
    expect(container.querySelector('aside')).not.toContainElement(dialog);
  });

  it('deletes on confirm and reports success once the request has settled', async () => {
    const onDeleteChat = jest.fn().mockResolvedValue(undefined);
    renderSidebar({ onDeleteChat });
    const dialog = openDeleteFor('Ancient refactor');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete chat' }));

    await waitFor(() => expect(onDeleteChat).toHaveBeenCalledWith('c3'));
    expect(await screen.findByText('Chat deleted')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not claim success when the request fails', async () => {
    const onDeleteChat = jest.fn().mockRejectedValue(new Error('network'));
    renderSidebar({ onDeleteChat });
    const dialog = openDeleteFor('Ancient refactor');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete chat' }));

    expect(await screen.findByText('Could not delete the chat. Try again.')).toBeInTheDocument();
    expect(screen.queryByText('Chat deleted')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
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
    expect(studioButtons[0]?.className).toContain('bg-fill-selected');
  });

  // The selected chat is only "current" on a chat page. On any other page
  // (the Terminal has no nav entry, so nothing else is current there) it must
  // not keep the fill and accent bar, or the sidebar names a destination the
  // user is not on.
  it('marks the selected chat row current on a chat page only', () => {
    const { unmount } = renderSidebar({ currentPage: 'chat' });
    const row = () => screen.getByText('Plugin LSP TypeScript').closest('li');
    expect(row()?.classList.contains('bg-fill-selected')).toBe(true);
    unmount();

    renderSidebar({ currentPage: 'terminal' });
    expect(row()?.classList.contains('bg-fill-selected')).toBe(false);
    // Nor does any nav entry claim to be the current page.
    expect(document.querySelector('[aria-current="page"]')).toBeNull();
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

  // The stored width is a desktop preference. Applied inline at every width it
  // made the phone's slide-over 256px, which left a chat title one letter.
  it('takes the stored width from md up and most of the screen below it', () => {
    const { container } = renderSidebar({ width: 300 });
    const aside = container.querySelector('aside');
    expect(aside?.style.width).toBe('');
    expect(aside?.style.getPropertyValue('--chat-sidebar-width')).toBe('300px');
    expect(aside).toHaveClass('w-[85vw]', 'max-w-sm', 'md:w-(--chat-sidebar-width)');
  });

  it('lets the git badge and the runner name give way to the title on a touch screen', () => {
    renderSidebar({
      gitSummaries: {
        c1: { branch: 'main', ahead: 0, behind: 0, changedFileCount: 0, workdir: '/w' },
      },
    });
    const row = screen.getByText('Plugin LSP TypeScript').closest('li') as HTMLElement;
    expect(within(row).getByTestId('git-summary-badge').parentElement).toHaveClass(
      'pointer-coarse:hidden'
    );
    // The name stays for assistive tech and for the search that matches it.
    expect(within(row).getByText('codex')).toHaveClass('pointer-coarse:sr-only');
  });

  it('keeps rename and delete up on a touch screen for the open chat only', () => {
    renderSidebar();
    const open = screen.getByText('Plugin LSP TypeScript').closest('li') as HTMLElement;
    const other = screen.getByText('sse-soak load test').closest('li') as HTMLElement;
    // Two 44px buttons on every row took most of it and left a destructive one
    // a tap away down the whole list; the other rows keep the title's width.
    expect(within(open).getByTitle('Edit title').parentElement).toHaveClass('pointer-coarse:flex');
    expect(within(other).getByTitle('Edit title').parentElement).not.toHaveClass(
      'pointer-coarse:flex'
    );
    expect(within(other).getByTitle('Delete chat').parentElement).not.toHaveClass(
      'pointer-coarse:flex'
    );
  });

  it('reads the runner as its dot alone below the width that has room for words, and in full from it', () => {
    // The default and the minimum: the title needs every character the word
    // would take. The word is still in the document either way — it is what the
    // search matches and what a screen reader says.
    const narrow = renderSidebar();
    const narrowRow = screen.getByText('Plugin LSP TypeScript').closest('li') as HTMLElement;
    expect(within(narrowRow).getByText('codex')).toHaveClass('sr-only');
    expect(within(narrowRow).getByText('codex').previousElementSibling).toHaveAttribute(
      'data-tone',
      'neutral'
    );
    narrow.unmount();

    renderSidebar({ width: 320 });
    const wideRow = screen.getByText('Plugin LSP TypeScript').closest('li') as HTMLElement;
    expect(within(wideRow).getByText('codex')).not.toHaveClass('sr-only');
  });

  it('stops the browser underlining the query as a misspelled word', () => {
    renderSidebar();
    const search = screen.getByLabelText('Search chats…');
    expect(search).toHaveAttribute('spellcheck', 'false');
    expect(search).toHaveAttribute('autocomplete', 'off');
  });

  it("lays the page entries on the chat list's inset, with their glyphs in the chat rows' slot", () => {
    renderSidebar();
    const settings = screen
      .getAllByRole('button', { name: 'Settings' })
      .find((button) => button.closest('[data-testid="mobile-shortcuts"]') === null) as HTMLElement;
    // The same 12px inset as the chat list, so the pills share their edges…
    expect(settings.parentElement).toHaveClass('px-3');
    expect(settings.parentElement).not.toHaveClass('p-2');
    // …and the same centred 20px slot, so labels and titles share their x.
    const slot = settings.querySelector('svg')?.parentElement;
    expect(slot).toHaveClass('size-5', 'shrink-0', 'justify-center');
    expect(settings).toHaveClass('gap-2');
  });

  it('draws Home and Gallery with glyphs that cannot be mistaken for each other', () => {
    renderSidebar();
    const glyph = (name: string) =>
      within(screen.getByTestId('mobile-shortcuts'))
        .getByRole('button', { name })
        .querySelector('svg');
    expect(glyph('Home')).toHaveClass('lucide-house');
    expect(glyph('Gallery')).toHaveClass('lucide-layout-grid');
    expect(glyph('Studio')).toHaveClass('lucide-image');
  });

  it('caps a mobile shortcut label to its cell so a long one ends in an ellipsis', () => {
    renderSidebar();
    const tile = within(screen.getByTestId('mobile-shortcuts')).getByRole('button', {
      name: /environments/i,
    });
    expect(within(tile).getByText(/environments/i)).toHaveClass('max-w-full', 'truncate');
  });

  it('resizes from the keyboard and persists the clamped width', () => {
    const onWidthChange = jest.fn();
    const { container } = renderSidebar({ width: 256, onWidthChange });
    const handle = screen.getByRole('separator', { name: /resize chat sidebar/i });
    expect(handle).toHaveAttribute('aria-valuenow', '256');
    // `h-auto` overrides the preflight `hr { height: 0 }`; without it the handle is unhittable.
    expect(handle).toHaveClass('h-auto');
    expect(handle.nextElementSibling).toHaveClass('bg-stroke');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyUp(handle, { key: 'ArrowRight' });
    expect(onWidthChange).toHaveBeenCalledWith(272);
    expect(container.querySelector('aside')?.style.getPropertyValue('--chat-sidebar-width')).toBe(
      '272px'
    );
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
    expect(container.querySelector('aside')?.style.getPropertyValue('--chat-sidebar-width')).toBe(
      '296px'
    );
  });
});
