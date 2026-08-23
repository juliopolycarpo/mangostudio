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
    fireEvent.click(screen.getByText('sse-soak load test'));
    expect(props.onSelectChat).toHaveBeenCalledWith('c2');
  });

  it('renames through the inline editor', () => {
    const { props } = renderSidebar();
    const row = screen.getByText('Plugin LSP TypeScript').closest('[role="button"]');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row as HTMLElement).getByTitle('Edit title'));
    const editor = screen.getByDisplayValue<HTMLInputElement>('Plugin LSP TypeScript');
    fireEvent.change(editor, { target: { value: 'Renamed' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(props.onUpdateChatTitle).toHaveBeenCalledWith('c1', 'Renamed');
  });

  it('deletes from the row action', () => {
    const { props } = renderSidebar();
    const row = screen.getByText('Ancient refactor').closest('[role="button"]');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row as HTMLElement).getByTitle('Delete chat'));
    expect(props.onDeleteChat).toHaveBeenCalledWith('c3');
  });

  it('does not let Enter/Space on the edit or delete buttons activate the row', () => {
    const { props } = renderSidebar();
    const row = screen.getByText('Plugin LSP TypeScript').closest('[role="button"]');
    if (!row) throw new Error('row not found');
    fireEvent.keyDown(within(row as HTMLElement).getByTitle('Edit title'), { key: 'Enter' });
    fireEvent.keyDown(within(row as HTMLElement).getByTitle('Delete chat'), { key: ' ' });
    expect(props.onSelectChat).not.toHaveBeenCalled();
  });

  it('does not let a space in the inline editor activate the row', () => {
    const { props } = renderSidebar();
    const row = screen.getByText('Plugin LSP TypeScript').closest('[role="button"]');
    if (!row) throw new Error('row not found');
    fireEvent.click(within(row as HTMLElement).getByTitle('Edit title'));
    const editor = screen.getByDisplayValue<HTMLInputElement>('Plugin LSP TypeScript');
    fireEvent.keyDown(editor, { key: ' ' });
    expect(props.onSelectChat).not.toHaveBeenCalled();
  });
});
