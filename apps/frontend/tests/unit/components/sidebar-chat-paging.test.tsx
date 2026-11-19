/**
 * The sidebar over a chat list that continues past what is loaded: it asks for
 * the next page when its end scrolls into view, leaves a failed page for the
 * reader to retry, shows the hub's matches for a search instead of reading
 * every page, and pins the open chat when the loaded pages do not hold it.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import type { Chat } from '@mangostudio/shared/chat';
import { en } from '@mangostudio/shared/i18n';
import { fireEvent, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';

import type { ChatPaging } from '../../../src/features/chat/chat-list-pages';
import type { ChatSearchResult } from '../../../src/features/chat/queries';
import { Sidebar } from '../../../src/features/sidebar/components/Sidebar';
import { LIST_END_ATTRIBUTE } from '../../../src/features/sidebar/hooks/use-load-more-on-visible';
import { render } from '../../support/harness/render';
import {
  type FakeIntersectionObserverHandle,
  installFakeIntersectionObserver,
} from '../../support/mocks/fake-intersection-observer';

const NOW = Date.now();

const LOADED_CHATS = [
  { id: 'c1', title: 'Newest chat', updatedAt: NOW, runner: { kind: 'mangostudio' } },
  { id: 'c2', title: 'Second chat', updatedAt: NOW - 1, runner: { kind: 'mangostudio' } },
] as unknown as Chat[];

function pagingWith(overrides: Partial<ChatPaging>): ChatPaging {
  return {
    hasMore: true,
    isLoadingMore: false,
    loadFailed: false,
    loadMore: jest.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function renderSidebar(
  chatPaging: ChatPaging,
  extra: Partial<ComponentProps<typeof Sidebar>> = {}
) {
  return render(
    <Sidebar
      currentPage="chat"
      onNavigate={jest.fn()}
      chats={LOADED_CHATS}
      currentChatId="c1"
      onSelectChat={jest.fn()}
      onUpdateChatTitle={jest.fn()}
      onDeleteChat={jest.fn()}
      onNewChat={jest.fn()}
      chatPaging={chatPaging}
      {...extra}
    />
  );
}

function searchResult(overrides: Partial<ChatSearchResult> = {}): ChatSearchResult {
  return {
    chats: [],
    paging: pagingWith({ hasMore: false }),
    isPending: false,
    isError: false,
    ...overrides,
  };
}

function typeSearch(text: string) {
  fireEvent.change(screen.getByPlaceholderText(en.sidebar.searchPlaceholder), {
    target: { value: text },
  });
}

/** Titles of the rows in the chat list, in order. */
function rowTitles(): string[] {
  const list = screen.getByRole('navigation', { name: en.chat.sectionLabel });
  return within(list)
    .queryAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((text) => ['Newest chat', 'Second chat', 'Deep chat', 'Needle chat'].includes(text));
}

/** The end-of-list marker; `[attr=""]` matches the empty value it carries. */
function listEnd(): Element | null {
  return document.querySelector(`[${LIST_END_ATTRIBUTE}]`);
}

let observer: FakeIntersectionObserverHandle;

beforeEach(() => {
  window.localStorage.setItem('mangostudio:locale', 'en');
  observer = installFakeIntersectionObserver();
});

afterEach(() => {
  observer.restore();
  window.localStorage.clear();
});

describe('sidebar chat paging', () => {
  it('renders no end marker once every chat is loaded', () => {
    renderSidebar(pagingWith({ hasMore: false }));

    expect(listEnd(), 'expected no end-of-list marker when hasMore is false').toBeNull();
    expect(observer.liveObserverCount()).toBe(0);
  });

  it('asks for the next page when the end of the list scrolls into view', () => {
    const paging = pagingWith({});
    renderSidebar(paging);
    expect(listEnd(), 'expected an end-of-list marker while pages remain').not.toBeNull();

    observer.setInView([''], LIST_END_ATTRIBUTE);

    expect(paging.loadMore).toHaveBeenCalledTimes(1);
  });

  it('does not ask while the end of the list is out of view', () => {
    const paging = pagingWith({});
    renderSidebar(paging);

    observer.setInView(['c1'], LIST_END_ATTRIBUTE);

    expect(paging.loadMore).not.toHaveBeenCalled();
  });

  it('says a page is loading and watches nothing until it lands', () => {
    const paging = pagingWith({ isLoadingMore: true });
    renderSidebar(paging);

    expect(screen.getByRole('status')).toHaveTextContent(en.sidebar.loadingMore);
    expect(
      observer.liveObserverCount(),
      'expected no observer while a page is in flight, so one load is not asked for twice'
    ).toBe(0);
  });

  it('leaves a failed page to the reader, who retries with the button', () => {
    const paging = pagingWith({ loadFailed: true });
    renderSidebar(paging);

    observer.setInView([''], LIST_END_ATTRIBUTE);
    expect(paging.loadMore, 'expected no automatic retry of a failed page').not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('sidebar-load-more'));

    expect(paging.loadMore).toHaveBeenCalledTimes(1);
  });

  it('reports "no results" once the whole list is loaded and nothing matches', () => {
    renderSidebar(pagingWith({ hasMore: false }));

    typeSearch('absent from every page');

    expect(screen.getByText(en.sidebar.searchNoResultsHint)).toBeInTheDocument();
  });

  it('does not read further pages on its own for a search typed without a server search', () => {
    const paging = pagingWith({});
    renderSidebar(paging);

    typeSearch('needle');

    expect(paging.loadMore, 'expected typing to load no page by itself').not.toHaveBeenCalled();
  });
});

describe('sidebar search through the hub', () => {
  const NEEDLE_CHAT = {
    id: 'c9',
    title: 'Needle chat',
    updatedAt: NOW - 1000,
    runner: { kind: 'mangostudio' },
  } as unknown as Chat;

  it('reports each change of the search text, so the shell can ask the hub', () => {
    const onSearchTextChange = jest.fn();
    renderSidebar(pagingWith({}), { onSearchTextChange });

    typeSearch('nee');
    typeSearch('needle');
    fireEvent.click(screen.getByTestId('sidebar-search-clear'));

    expect(onSearchTextChange.mock.calls.map(([text]) => text)).toEqual(['nee', 'needle', '']);
  });

  it('lists the hub matches, which include chats the loaded pages do not hold', () => {
    const paging = pagingWith({});
    renderSidebar(paging, {
      onSearchTextChange: jest.fn(),
      chatSearch: searchResult({ chats: [NEEDLE_CHAT] }),
    });

    typeSearch('needle');

    expect(rowTitles()).toEqual(['Needle chat']);
    expect(
      paging.loadMore,
      'expected no page of the plain list to be read for a search'
    ).not.toHaveBeenCalled();
  });

  it('shows the matches of the loaded pages until the first reply arrives, without saying "no results"', () => {
    renderSidebar(pagingWith({}), {
      onSearchTextChange: jest.fn(),
      chatSearch: searchResult({ isPending: true }),
    });

    typeSearch('second');

    expect(rowTitles()).toEqual(['Second chat']);
    typeSearch('absent');
    expect(screen.queryByText(en.sidebar.searchNoResultsHint)).toBeNull();
  });

  it('reports "no results" when the hub answered and nothing matched', () => {
    renderSidebar(pagingWith({}), {
      onSearchTextChange: jest.fn(),
      chatSearch: searchResult(),
    });

    typeSearch('absent');

    expect(screen.getByText(en.sidebar.searchNoResultsHint)).toBeInTheDocument();
  });

  it('pages the matches, not the list, when the end of the results scrolls into view', () => {
    const listPaging = pagingWith({});
    const searchPaging = pagingWith({});
    renderSidebar(listPaging, {
      onSearchTextChange: jest.fn(),
      chatSearch: searchResult({ chats: [NEEDLE_CHAT], paging: searchPaging }),
    });
    typeSearch('needle');

    observer.setInView([''], LIST_END_ATTRIBUTE);

    expect(searchPaging.loadMore).toHaveBeenCalledTimes(1);
    expect(listPaging.loadMore).not.toHaveBeenCalled();
  });

  it('falls back to the loaded pages when the search fails, instead of claiming nothing matches', () => {
    renderSidebar(pagingWith({ hasMore: false }), {
      onSearchTextChange: jest.fn(),
      chatSearch: searchResult({ isError: true }),
    });

    typeSearch('second');

    expect(rowTitles()).toEqual(['Second chat']);
  });

  it('shows the whole list again once the search is cleared', () => {
    renderSidebar(pagingWith({ hasMore: false }), {
      onSearchTextChange: jest.fn(),
      chatSearch: searchResult({ chats: [NEEDLE_CHAT] }),
    });
    typeSearch('needle');

    fireEvent.click(screen.getByTestId('sidebar-search-clear'));

    expect(rowTitles()).toEqual(['Newest chat', 'Second chat']);
  });
});

describe('sidebar pinned chat', () => {
  const DEEP_CHAT = {
    id: 'c-deep',
    title: 'Deep chat',
    updatedAt: NOW - 90 * 86_400_000,
    runner: { kind: 'mangostudio' },
  } as unknown as Chat;

  it('shows the open chat above the list under its own heading, highlighted', () => {
    renderSidebar(pagingWith({}), { pinnedChat: DEEP_CHAT, currentChatId: 'c-deep' });

    expect(screen.getByText(en.sidebar.currentChatGroup)).toBeInTheDocument();
    expect(rowTitles()).toEqual(['Deep chat', 'Newest chat', 'Second chat']);
    expect(screen.getByRole('button', { name: 'Deep chat' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('selects the pinned chat like any other row', () => {
    const onSelectChat = jest.fn();
    renderSidebar(pagingWith({}), { pinnedChat: DEEP_CHAT, currentChatId: 'c1', onSelectChat });

    fireEvent.click(screen.getByRole('button', { name: 'Deep chat' }));

    expect(onSelectChat).toHaveBeenCalledWith('c-deep');
  });

  it('does not save an untouched name of a pinned chat as a rename', () => {
    const untitled = { ...DEEP_CHAT, title: '' } as Chat;
    const onUpdateChatTitle = jest.fn();
    renderSidebar(pagingWith({}), {
      pinnedChat: untitled,
      currentChatId: 'c-deep',
      onUpdateChatTitle,
    });

    fireEvent.click(screen.getAllByRole('button', { name: en.chat.editTitle })[0] as HTMLElement);
    fireEvent.blur(screen.getByRole('textbox', { name: en.chat.editTitle }));

    expect(onUpdateChatTitle).not.toHaveBeenCalled();
  });

  it('shows no pinned heading when there is no pinned chat', () => {
    renderSidebar(pagingWith({}));

    expect(screen.queryByText(en.sidebar.currentChatGroup)).toBeNull();
  });

  it('leaves the pinned chat out of a search it does not match', () => {
    renderSidebar(pagingWith({ hasMore: false }), {
      pinnedChat: DEEP_CHAT,
      currentChatId: 'c-deep',
    });

    typeSearch('second');

    expect(rowTitles()).toEqual(['Second chat']);
    expect(screen.queryByText(en.sidebar.currentChatGroup)).toBeNull();
  });
});
