/**
 * The lock signal behind D14 and the session-identity controls.
 *
 * The conservative arm matters most: an unloaded transcript must read as
 * "has turns", because unlocking on it would let an existing chat's runner,
 * environment or workdir change in place while its messages are still on the
 * wire.
 */

import { describe, expect, it } from 'bun:test';

import type { Message } from '@mangostudio/shared/chat';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook as renderHookWithOwnClient } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

import { messageKeys } from '../../../src/features/chat/queries';
import type { MessagesCache } from '../../../src/features/chat/transcript-pages';
import { patchMessageInCache } from '../../../src/features/generation/message-cache-patch';
import { flushAsyncRender, renderHook, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const { selectTranscriptIsEmpty, useChatHasTurns } =
  await import('../../../src/features/chat/hooks/use-chat-has-turns');

const liveMessage = (text: string): Message => ({
  id: 'ai-1',
  chatId: 'chat-1',
  role: 'ai',
  text,
  timestamp: 1_700_000_000_000,
  isGenerating: true,
});

describe('selectTranscriptIsEmpty', () => {
  const page = (messages: Message[]) => ({ messages, nextCursor: null });

  it('is true for no pages and for pages without rows', () => {
    expect(selectTranscriptIsEmpty({ pages: [], pageParams: [] })).toBe(true);
    expect(selectTranscriptIsEmpty({ pages: [page([]), page([])], pageParams: [null, 'c'] })).toBe(
      true
    );
  });

  it('is false once any page holds a row', () => {
    expect(
      selectTranscriptIsEmpty({
        pages: [page([]), page([liveMessage('hi')])],
        pageParams: [null, 'c'],
      })
    ).toBe(false);
  });
});

describe('useChatHasTurns while a reply streams', () => {
  it('does not re-render its host when a chunk only changes a message text', async () => {
    // Seeded and never stale, so no request is made: the only cache writes are
    // the patches below, which is what the stream does once per chunk.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    const seeded: MessagesCache = {
      pages: [{ messages: [liveMessage('')], nextCursor: null }],
      pageParams: [null],
    };
    queryClient.setQueryData(messageKeys.list('chat-1'), seeded);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const renderCount = { current: 0 };
    // Testing-library's own `renderHook`: the harness one pins its own
    // QueryClient, and this test has to write to the one the hook reads.
    const { result } = renderHookWithOwnClient(
      () => {
        renderCount.current += 1;
        return useChatHasTurns('chat-1');
      },
      { wrapper }
    );
    await flushAsyncRender();
    expect(result.current).toBe(true);
    const rendersBeforeStream = renderCount.current;

    const CHUNKS = 20;
    for (let chunk = 1; chunk <= CHUNKS; chunk += 1) {
      queryClient.setQueryData<MessagesCache>(messageKeys.list('chat-1'), (cache) =>
        patchMessageInCache(cache, 'ai-1', { text: `chunk ${chunk}` })
      );
      await flushAsyncRender();
    }

    expect(
      renderCount.current - rendersBeforeStream,
      `(useChatHasTurns): expected host re-renders across ${CHUNKS} text patches: 0 | received: ${renderCount.current - rendersBeforeStream}`
    ).toBe(0);
    expect(result.current).toBe(true);
  });
});

describe('useChatHasTurns', () => {
  it('reports no turns for a chat that has no id yet', () => {
    const { result } = renderHook(() => useChatHasTurns(null));
    expect(result.current).toBe(false);
  });

  it('locks while the transcript is unloaded, then unlocks on an empty one', async () => {
    const scenario = createFetchScenario();
    scenario
      .respondWithJson('GET', '/api/chats/chat-1/messages?limit=50&order=desc', {
        body: { messages: [], nextCursor: null },
      })
      .install();

    try {
      const { result } = renderHook(() => useChatHasTurns('chat-1'));
      // First render: the query has not answered, and "not answered" must not
      // read as "empty".
      expect(result.current).toBe(true);
      await waitFor(() => expect(result.current).toBe(false));
    } finally {
      scenario.restore();
    }
  });

  it('stays locked once the transcript carries a message', async () => {
    const scenario = createFetchScenario();
    scenario
      .respondWithJson('GET', '/api/chats/chat-1/messages?limit=50&order=desc', {
        body: {
          messages: [{ id: 'm1', chatId: 'chat-1', role: 'user', content: 'hi', parts: [] }],
          nextCursor: null,
        },
      })
      .install();

    try {
      const { result } = renderHook(() => useChatHasTurns('chat-1'));
      await waitFor(() => expect(scenario.fetchMock).toHaveBeenCalled());
      await waitFor(() => expect(result.current).toBe(true));
      expect(result.current).toBe(true);
    } finally {
      scenario.restore();
    }
  });
});
