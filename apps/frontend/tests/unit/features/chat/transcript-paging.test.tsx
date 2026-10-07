/**
 * The chat transcript opens on its newest messages and pages back on demand.
 *
 * A chat with more than one page of messages used to show only its OLDEST page:
 * the transcript query asked for the first 50 rows oldest-first and never asked
 * again, so every newer message was invisible. These tests drive the hook the
 * chat page reads through a fake hub that pages like the real route.
 */

import { describe, expect, it } from 'bun:test';
import type { Message } from '@mangostudio/shared/chat';
import { useQueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '../../../support/harness/render';
import { FakeTranscriptApi } from '../../../support/mocks/fake-transcript-api';

const { useChatPageMessages } = await import(
  '../../../../src/features/chat/hooks/use-chat-page-state'
);
const { useOptimisticMessages } = await import(
  '../../../../src/features/generation/hooks/use-optimistic-messages'
);
const { messageKeys, messagesQueryOptions } = await import('../../../../src/features/chat/queries');

const CHAT_ID = 'chat-1';

/** `msg-071 .. msg-120 (50)`: the first and last text and the count, for a one-line failure. */
function summarize(messages: readonly Message[]): string {
  const first = messages[0]?.text ?? 'none';
  const last = messages.at(-1)?.text ?? 'none';
  return `${first} .. ${last} (${messages.length})`;
}

/**
 * Fails as `expected transcript: msg-021 .. msg-120 (100) | received: ...`, and
 * also when the messages are not one unbroken chronological run: a repeated or
 * missing message anywhere inside the span fails even if the ends are right.
 */
function expectTranscript(messages: readonly Message[], expected: string) {
  const received = summarize(messages);
  if (received !== expected) {
    throw new Error(`expected transcript: ${expected} | received: ${received}`);
  }
  const broken = messages.findIndex((message, index) => {
    if (index === 0) return false;
    return Number(message.text.slice(4)) !== Number(messages[index - 1]?.text.slice(4)) + 1;
  });
  if (broken !== -1) {
    throw new Error(
      `expected transcript: one run | received: ${messages[broken - 1]?.text} then ${messages[broken]?.text}`
    );
  }
}

function renderTranscript() {
  return renderHook(() => ({
    ...useChatPageMessages({ chatId: CHAT_ID }),
    queryClient: useQueryClient(),
    optimistic: useOptimisticMessages(),
  }));
}

type Transcript = ReturnType<typeof renderTranscript>['result'];

async function opened(transcript: Transcript) {
  await waitFor(() => expect(transcript.current.status).toBe('success'));
}

/** Re-reads the transcript the way every turn's end does, and waits for the read. */
async function refetchTranscript(transcript: Transcript) {
  await act(async () => {
    await transcript.current.queryClient.invalidateQueries({ queryKey: messageKeys.list(CHAT_ID) });
  });
}

/** Loads one older page and waits for it to land. */
async function loadOlder(transcript: Transcript) {
  const before = transcript.current.messages.length;
  await act(() => {
    transcript.current.older.load();
  });
  await waitFor(() => expect(transcript.current.messages.length).toBeGreaterThan(before));
}

describe('transcript query options', () => {
  // Bounding the refetch uses TanStack's `persister`, which would otherwise
  // switch the query to `offlineFirst`: an offline tab would fail instead of wait.
  it('waits for the network like every other query', () => {
    expect(`network mode: ${messagesQueryOptions(CHAT_ID).networkMode}`).toBe(
      'network mode: online'
    );
  });
});

describe('transcript opening', () => {
  it('opens a 120-message chat on its newest 50 messages', async () => {
    const api = new FakeTranscriptApi({ chatId: CHAT_ID, total: 120 }).install();
    try {
      const { result } = renderTranscript();
      await opened(result);

      expectTranscript(result.current.messages, 'msg-071 .. msg-120 (50)');
      expect(result.current.older.hasMore).toBe(true);
    } finally {
      api.restore();
    }
  });

  it('opens a chat that fits one page whole, with nothing older to load', async () => {
    const api = new FakeTranscriptApi({ chatId: CHAT_ID, total: 30 }).install();
    try {
      const { result } = renderTranscript();
      await opened(result);

      expectTranscript(result.current.messages, 'msg-001 .. msg-030 (30)');
      expect(result.current.older.hasMore).toBe(false);
    } finally {
      api.restore();
    }
  });
});

describe('loading older messages', () => {
  it('prepends the previous page in order, without duplicates', async () => {
    const api = new FakeTranscriptApi({ chatId: CHAT_ID, total: 120 }).install();
    try {
      const { result } = renderTranscript();
      await opened(result);

      await loadOlder(result);

      expectTranscript(result.current.messages, 'msg-021 .. msg-120 (100)');
    } finally {
      api.restore();
    }
  });

  it('fetches the previous page once however often it is asked for', async () => {
    const api = new FakeTranscriptApi({ chatId: CHAT_ID, total: 120 }).install();
    try {
      const { result } = renderTranscript();
      await opened(result);

      api.hold();
      await act(() => {
        result.current.older.load();
        result.current.older.load();
        result.current.older.load();
      });
      await waitFor(() => expect(result.current.older.isLoading).toBe(true));
      await act(() => {
        result.current.older.load();
      });
      api.release();
      await waitFor(() => expect(result.current.messages.length).toBe(100));

      const olderRequests = api.requests.filter((request) => request.includes('cursor='));
      expect(`older page requests: ${olderRequests.length}`).toBe('older page requests: 1');
    } finally {
      api.restore();
    }
  });

  it('stops asking once the first message is loaded', async () => {
    const api = new FakeTranscriptApi({ chatId: CHAT_ID, total: 120 }).install();
    try {
      const { result } = renderTranscript();
      await opened(result);

      await loadOlder(result);
      await loadOlder(result);
      expectTranscript(result.current.messages, 'msg-001 .. msg-120 (120)');
      expect(result.current.older.hasMore).toBe(false);

      const requestsBefore = api.requests.length;
      await act(() => {
        result.current.older.load();
      });
      expect(`requests after the last page: ${api.requests.length - requestsBefore}`).toBe(
        'requests after the last page: 0'
      );
    } finally {
      api.restore();
    }
  });
});

describe('the live end of the transcript', () => {
  it('shows an optimistic message at the end', async () => {
    const api = new FakeTranscriptApi({ chatId: CHAT_ID, total: 120 }).install();
    try {
      const { result } = renderTranscript();
      await opened(result);
      await loadOlder(result);

      act(() => {
        result.current.optimistic.appendOptimisticMessages(CHAT_ID, [
          { ...FakeTranscriptApi.messageAt(CHAT_ID, 121), id: 'optimistic-1', text: 'sending' },
        ]);
      });

      await waitFor(() => {
        const last = result.current.messages.at(-1)?.text;
        expect(`last message: ${last}`).toBe('last message: sending');
      });
    } finally {
      api.restore();
    }
  });

  it('replaces the optimistic message with the stored one when the transcript refetches', async () => {
    const api = new FakeTranscriptApi({ chatId: CHAT_ID, total: 120 }).install();
    try {
      const { result } = renderTranscript();
      await opened(result);
      await loadOlder(result);

      act(() => {
        result.current.optimistic.appendOptimisticMessages(CHAT_ID, [
          { ...FakeTranscriptApi.messageAt(CHAT_ID, 121), id: 'optimistic-1' },
        ]);
      });
      api.appendMessage();
      await refetchTranscript(result);

      await waitFor(() => expectTranscript(result.current.messages, 'msg-021 .. msg-121 (101)'));
      const optimistic = result.current.messages.filter((message) => message.id === 'optimistic-1');
      expect(`optimistic rows left: ${optimistic.length}`).toBe('optimistic rows left: 0');
    } finally {
      api.restore();
    }
  });

  it('keeps the older pages and re-reads only the newest end after a turn', async () => {
    const api = new FakeTranscriptApi({ chatId: CHAT_ID, total: 120 }).install();
    try {
      const { result } = renderTranscript();
      await opened(result);
      await loadOlder(result);
      await loadOlder(result);

      api.appendMessage();
      api.appendMessage();
      const requestsBefore = api.requests.length;
      await refetchTranscript(result);

      await waitFor(() => expectTranscript(result.current.messages, 'msg-001 .. msg-122 (122)'));
      const reread = api.requests.length - requestsBefore;
      expect(`requests to refresh 3 loaded pages: ${reread}`).toBe(
        'requests to refresh 3 loaded pages: 2'
      );
      expect(result.current.older.hasMore).toBe(false);
    } finally {
      api.restore();
    }
  });

  it('re-reads a single page when nothing was added', async () => {
    const api = new FakeTranscriptApi({ chatId: CHAT_ID, total: 120 }).install();
    try {
      const { result } = renderTranscript();
      await opened(result);
      await loadOlder(result);

      const requestsBefore = api.requests.length;
      await refetchTranscript(result);

      expectTranscript(result.current.messages, 'msg-021 .. msg-120 (100)');
      expect(`requests to refresh: ${api.requests.length - requestsBefore}`).toBe(
        'requests to refresh: 1'
      );
    } finally {
      api.restore();
    }
  });
});
