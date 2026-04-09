/**
 * Unit tests for useOptimisticMessages — optimistic cache mutation helpers.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '../../support/harness/render';
import { useOptimisticMessages } from '../../../src/hooks/use-optimistic-messages';
import { useQueryClient } from '@tanstack/react-query';
import { messageKeys } from '../../../src/hooks/use-messages-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { Message } from '@mangostudio/shared';
import type { MessagesPage } from '../../../src/hooks/use-messages-query';

type MessagesCache = InfiniteData<MessagesPage, string | null>;

function makeMessage(id: string, text: string): Message {
  return {
    id,
    chatId: 'test-chat',
    role: 'user',
    text,
    timestamp: new Date(Date.now()),
    isGenerating: false,
    interactionMode: 'chat',
  };
}

function makeCache(messages: Message[]): MessagesCache {
  return {
    pages: [{ messages, nextCursor: null }],
    pageParams: [null],
  };
}

/** Renders useOptimisticMessages plus useQueryClient so tests can inspect the cache. */
function renderOptimistic() {
  return renderHook(() => {
    const optimistic = useOptimisticMessages();
    const queryClient = useQueryClient();
    return { ...optimistic, queryClient };
  });
}

describe('appendOptimisticMessages', () => {
  it('seeds an empty cache on first call (cold cache)', () => {
    const { result } = renderOptimistic();

    const msg = makeMessage('m1', 'Hello');
    act(() => {
      result.current.appendOptimisticMessages('test-chat', [msg]);
    });

    const cache = result.current.queryClient.getQueryData<MessagesCache>(
      messageKeys.list('test-chat')
    );
    expect(cache?.pages[0]?.messages).toHaveLength(1);
    expect(cache?.pages[0]?.messages[0]?.id).toBe('m1');
  });

  it('appends messages to an existing cache page', () => {
    const existing = makeMessage('m-existing', 'Existing');
    const { result } = renderOptimistic();

    act(() => {
      result.current.queryClient.setQueryData(messageKeys.list('test-chat'), makeCache([existing]));
    });

    const added = makeMessage('m-added', 'Added');
    act(() => {
      result.current.appendOptimisticMessages('test-chat', [added]);
    });

    const cache = result.current.queryClient.getQueryData<MessagesCache>(
      messageKeys.list('test-chat')
    );
    expect(cache?.pages[0]?.messages).toHaveLength(2);
    expect(cache?.pages[0]?.messages.map((m) => m.id)).toEqual(['m-existing', 'm-added']);
  });
});

describe('replaceOptimisticMessages', () => {
  it('replaces matching ids with new messages on a warm cache', () => {
    const old = makeMessage('m-old', 'Old');
    const { result } = renderOptimistic();

    act(() => {
      result.current.queryClient.setQueryData(messageKeys.list('test-chat'), makeCache([old]));
    });

    const replacement = makeMessage('m-new', 'New');
    act(() => {
      result.current.replaceOptimisticMessages('test-chat', ['m-old'], [replacement]);
    });

    const cache = result.current.queryClient.getQueryData<MessagesCache>(
      messageKeys.list('test-chat')
    );
    expect(cache?.pages[0]?.messages).toHaveLength(1);
    expect(cache?.pages[0]?.messages[0]?.id).toBe('m-new');
  });

  it('seeds a cold cache with the replacement messages', () => {
    const { result } = renderOptimistic();

    const replacement = makeMessage('m-seed', 'Seeded');
    act(() => {
      result.current.replaceOptimisticMessages('test-chat', ['m-missing'], [replacement]);
    });

    const cache = result.current.queryClient.getQueryData<MessagesCache>(
      messageKeys.list('test-chat')
    );
    expect(cache?.pages[0]?.messages[0]?.id).toBe('m-seed');
  });
});

describe('updateOptimisticMessage', () => {
  it('applies partial updates to a matching message in the cache', () => {
    const msg = makeMessage('m-upd', 'Original');
    const { result } = renderOptimistic();

    act(() => {
      result.current.queryClient.setQueryData(messageKeys.list('test-chat'), makeCache([msg]));
    });

    act(() => {
      result.current.updateOptimisticMessage('test-chat', 'm-upd', { text: 'Updated' });
    });

    const cache = result.current.queryClient.getQueryData<MessagesCache>(
      messageKeys.list('test-chat')
    );
    expect(cache?.pages[0]?.messages[0]?.text).toBe('Updated');
  });

  it('is a no-op when the cache is cold', () => {
    const { result } = renderOptimistic();

    act(() => {
      result.current.updateOptimisticMessage('test-chat', 'm-missing', { text: 'X' });
    });

    const cache = result.current.queryClient.getQueryData<MessagesCache>(
      messageKeys.list('test-chat')
    );
    expect(cache).toBeUndefined();
  });
});
