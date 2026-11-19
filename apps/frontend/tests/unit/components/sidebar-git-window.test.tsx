/**
 * The sidebar renders every chat but may only ask for the git badges of the rows
 * in its scroll window (#935). These tests wire the sidebar to the same hook the
 * shell uses and drive the window by hand through a fake `IntersectionObserver`.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import type { Chat } from '@mangostudio/shared/chat';
import type { GitBatchStateRequest, GitSummary } from '@mangostudio/shared/git';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';

import type * as ApiClient from '@/lib/api-client';

import { act, flushAsyncRender, render, waitFor } from '../../support/harness/render';
import {
  type FakeIntersectionObserverHandle,
  installFakeIntersectionObserver,
} from '../../support/mocks/fake-intersection-observer';

const mockBatch = jest.fn();

void mock.module('@/lib/api-client', () => ({
  client: {
    api: { git: { state: { batch: { post: mockBatch } } } },
  } as unknown as typeof ApiClient,
}));

// The hook binds the api client at import, so both come in after the mock.
const { Sidebar } = await import('@/features/sidebar/components/Sidebar');
const { useBatchedGitSummaries } = await import('@/features/workspace/hooks/use-git-state');
const { ROWS_IN_VIEW_SETTLE_MS } = await import('@/features/sidebar/hooks/use-rows-in-view');

const TOTAL_CHATS = 200;
const todayNoon = new Date();
todayNoon.setHours(12, 0, 0, 0);

const chatId = (index: number) => `chat-${String(index).padStart(3, '0')}`;
const idsFrom = (start: number, end: number) =>
  Array.from({ length: end - start }, (_, offset) => chatId(start + offset));

function makeChats(): Chat[] {
  return Array.from(
    { length: TOTAL_CHATS },
    (_, index) =>
      ({
        id: chatId(index),
        title: `Chat ${index}`,
        updatedAt: todayNoon.getTime() - index * 1000,
        runner: { kind: 'mangostudio', agentId: 'default' },
        workdir: `/repo/${index}`,
      }) as unknown as Chat
  );
}

function summaryFor(id: string): GitSummary {
  return { branch: `branch-${id}`, ahead: 0, behind: 0, changedFileCount: 2, workdir: '/repo' };
}

/** What `_authenticated.tsx` does: the sidebar reports its window, the hook fetches it. */
function ShellWithSidebar({ chats }: { chats: Chat[] }) {
  const [idsInView, setIdsInView] = useState<readonly string[]>([]);
  const gitSummaries = useBatchedGitSummaries(idsInView, { includeCached: true });
  return (
    <Sidebar
      currentPage="home"
      onNavigate={jest.fn()}
      chats={chats}
      currentChatId={null}
      onSelectChat={jest.fn()}
      onUpdateChatTitle={jest.fn()}
      onDeleteChat={jest.fn()}
      onNewChat={jest.fn()}
      gitSummaries={gitSummaries}
      onGitRowsInViewChange={setIdsInView}
    />
  );
}

const requestedIds = () =>
  mockBatch.mock.calls.map((call) => (call[0] as GitBatchStateRequest).chatIds);

/** Moves the window, then waits past the settle so the shell has been told. */
async function scrollTo(fake: FakeIntersectionObserverHandle, ids: readonly string[]) {
  await act(async () => {
    fake.setInView(ids);
    await new Promise((resolve) => setTimeout(resolve, ROWS_IN_VIEW_SETTLE_MS + 50));
  });
  await flushAsyncRender();
}

describe('sidebar git badges follow the scroll window', () => {
  let fake: FakeIntersectionObserverHandle;

  beforeEach(() => {
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/require-await -- The fake keeps the client's async contract.
    mockBatch.mockImplementation(async ({ chatIds }: GitBatchStateRequest) => ({
      data: { states: Object.fromEntries(chatIds.map((id) => [id, summaryFor(id)])) },
      error: null,
    }));
    fake = installFakeIntersectionObserver();
  });

  afterEach(() => {
    fake.restore();
  });

  it('watches the rows but requests nothing until a window is reported', async () => {
    render(<ShellWithSidebar chats={makeChats()} />);
    await flushAsyncRender();

    expect(fake.observedIds('data-row-in-view-id')).toHaveLength(TOTAL_CHATS);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('requests only the rows in view, not every chat in the account', async () => {
    render(<ShellWithSidebar chats={makeChats()} />);
    await flushAsyncRender();

    await scrollTo(fake, idsFrom(0, 24));
    await waitFor(() => expect(mockBatch).toHaveBeenCalled());

    expect(requestedIds()).toEqual([idsFrom(0, 24)]);
    await waitFor(() =>
      expect(
        within(screen.getByText('Chat 0').closest('li') as HTMLElement).getByTestId(
          'git-summary-badge'
        )
      ).toBeTruthy()
    );
  });

  it('requests only the newly revealed rows when the list scrolls', async () => {
    render(<ShellWithSidebar chats={makeChats()} />);
    await flushAsyncRender();
    await scrollTo(fake, idsFrom(0, 24));
    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(1));

    await scrollTo(fake, idsFrom(12, 36));
    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(2));

    expect(requestedIds()[1]).toEqual(idsFrom(24, 36));
  });

  it('keeps the badge of a row scrolled away and serves it again without a request', async () => {
    render(<ShellWithSidebar chats={makeChats()} />);
    await flushAsyncRender();
    await scrollTo(fake, idsFrom(0, 24));
    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(1));
    const rowOfFirstChat = () => screen.getByText('Chat 0').closest('li') as HTMLElement;
    await waitFor(() =>
      expect(within(rowOfFirstChat()).queryByTestId('git-summary-badge')).not.toBeNull()
    );

    await scrollTo(fake, idsFrom(100, 124));
    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(2));
    // Scrolled away: the row is still rendered and still wears its badge.
    expect(within(rowOfFirstChat()).queryByTestId('git-summary-badge')).not.toBeNull();

    await scrollTo(fake, idsFrom(0, 24));
    expect(within(rowOfFirstChat()).queryByTestId('git-summary-badge')).not.toBeNull();
    expect(mockBatch).toHaveBeenCalledTimes(2);
  });

  it('coalesces a fast scroll into one request for where it stopped', async () => {
    render(<ShellWithSidebar chats={makeChats()} />);
    await flushAsyncRender();

    await act(async () => {
      // Every intermediate window lands inside one settle period.
      for (let start = 0; start <= 150; start += 10) {
        fake.setInView(idsFrom(start, start + 24));
      }
      await new Promise((resolve) => setTimeout(resolve, ROWS_IN_VIEW_SETTLE_MS + 50));
    });
    await flushAsyncRender();
    await waitFor(() => expect(mockBatch).toHaveBeenCalled());

    expect(requestedIds()).toEqual([idsFrom(150, 174)]);
  });

  it('sends at most the endpoint limit per request when the window is taller than it', async () => {
    render(<ShellWithSidebar chats={makeChats()} />);
    await flushAsyncRender();

    await scrollTo(fake, idsFrom(0, 120));
    await waitFor(() => expect(mockBatch).toHaveBeenCalledTimes(3));

    expect(requestedIds().map((ids) => ids.length)).toEqual([50, 50, 20]);
  });
});
