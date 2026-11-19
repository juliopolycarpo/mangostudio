/**
 * The sidebar over a chat list that continues past what is loaded: it asks for
 * the next page when its end scrolls into view, reads every remaining page for
 * a search, and leaves a failed page for the reader to retry.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import type { Chat } from '@mangostudio/shared/chat';
import { en } from '@mangostudio/shared/i18n';
import { fireEvent, screen } from '@testing-library/react';

import type { ChatPaging } from '../../../src/features/chat/chat-list-pages';
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

function renderSidebar(chatPaging: ChatPaging) {
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
    />
  );
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

  it('reads the remaining pages for a search without waiting for the end to scroll into view', () => {
    const paging = pagingWith({});
    renderSidebar(paging);

    fireEvent.change(screen.getByPlaceholderText(en.sidebar.searchPlaceholder), {
      target: { value: 'needle' },
    });

    expect(paging.loadMore).toHaveBeenCalled();
  });

  it('does not report "no results" while pages that could match are still unread', () => {
    renderSidebar(pagingWith({ isLoadingMore: true }));

    fireEvent.change(screen.getByPlaceholderText(en.sidebar.searchPlaceholder), {
      target: { value: 'absent from the loaded pages' },
    });

    expect(screen.queryByText(en.sidebar.searchNoResultsHint)).toBeNull();
  });

  it('reports "no results" once the whole list is loaded and nothing matches', () => {
    renderSidebar(pagingWith({ hasMore: false }));

    fireEvent.change(screen.getByPlaceholderText(en.sidebar.searchPlaceholder), {
      target: { value: 'absent from every page' },
    });

    expect(screen.getByText(en.sidebar.searchNoResultsHint)).toBeInTheDocument();
  });
});
