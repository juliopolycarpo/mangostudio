/**
 * Transcript read-ahead through the real query: older pages are fetched ahead of
 * the reader without ever showing as loading, failing or blocking, and without
 * changing what a refresh after a turn costs.
 *
 * A fake hub pages like the real route; the browser's idle callback is a named
 * fake, so each test decides when the browser is idle. The reader is a position
 * and a wheel turn on a plain element.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Message } from '@mangostudio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { act, fireEvent, renderHook, waitFor } from '../../../support/harness/render';
import { FakeIdleScheduler } from '../../../support/mocks/fake-idle-scheduler';
import { FakeTranscriptApi } from '../../../support/mocks/fake-transcript-api';

const { useChatPageMessages } = await import(
  '../../../../src/features/chat/hooks/use-chat-page-state'
);
const { useTranscriptReadAhead } = await import(
  '../../../../src/features/chat/hooks/use-transcript-read-ahead'
);
const { useOptimisticMessages } = await import(
  '../../../../src/features/generation/hooks/use-optimistic-messages'
);
const { messageKeys } = await import('../../../../src/features/chat/queries');

const CHAT_ID = 'chat-1';
const VIEWPORT = 800;
const FAR_FROM_TOP = 50_000;

let idle: FakeIdleScheduler;
let api: FakeTranscriptApi;
let port: HTMLDivElement;
let reader = { firstVisibleIndex: 0, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };

beforeEach(() => {
  idle = new FakeIdleScheduler().install();
  port = document.createElement('div');
  document.body.append(port);
  reader = { firstVisibleIndex: 0, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
});

afterEach(() => {
  api?.restore();
  idle.restore();
  port.remove();
});

function serve(total: number) {
  api = new FakeTranscriptApi({ chatId: CHAT_ID, total }).install();
  return api;
}

interface TranscriptProps {
  readonly chatId: string;
  readonly paused: boolean;
}

/** The chat page's transcript with the feed's read-ahead on top, as ChatFeed wires them. */
function renderTranscript(initial: Partial<TranscriptProps> = {}) {
  return renderHook(
    (props: TranscriptProps) => {
      const transcript = useChatPageMessages({ chatId: props.chatId });
      const portRef = useRef<HTMLElement | null>(port);
      useTranscriptReadAhead({
        chatId: props.chatId,
        ready: transcript.status === 'success' && transcript.messages.length > 0,
        paused: props.paused,
        older: transcript.older,
        parentRef: portRef,
        readPosition: () => reader,
      });
      return {
        ...transcript,
        queryClient: useQueryClient(),
        optimistic: useOptimisticMessages(),
      };
    },
    { initialProps: { chatId: CHAT_ID, paused: false, ...initial } }
  );
}

type Transcript = ReturnType<typeof renderTranscript>['result'];

async function opened(transcript: Transcript) {
  await waitFor(() => expect(transcript.current.status).toBe('success'));
}

/** Fails as `expected older requests: 1 | received: 0`. */
function expectOlderRequests(expected: number) {
  expect(
    `older requests: ${api.olderRequests.length}`,
    `expected older requests: ${expected}`
  ).toBe(`older requests: ${expected}`);
}

function summarize(messages: readonly Message[]): string {
  const first = messages[0]?.text ?? 'none';
  const last = messages.at(-1)?.text ?? 'none';
  return `${first} .. ${last} (${messages.length})`;
}

function expectTranscript(messages: readonly Message[], expected: string) {
  const received = summarize(messages);
  if (received !== expected) {
    throw new Error(`expected transcript: ${expected} | received: ${received}`);
  }
}

/** The wheel turn that opens the scroll window, with the reader inside the first older page. */
async function scrollUpIntoOlderPage(firstVisibleIndex: number) {
  reader = { firstVisibleIndex, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
  fireEvent.wheel(port, { deltaY: -120 });
  await idle.runIdle();
}

describe('read-ahead window', () => {
  it('fetches nothing before the browser is idle, then exactly one older page', async () => {
    serve(220);
    const { result } = renderTranscript();
    await opened(result);

    expectOlderRequests(0);
    await idle.runIdle();
    await waitFor(() => expectTranscript(result.current.messages, 'msg-121 .. msg-220 (100)'));

    expectOlderRequests(1);
  });

  it('reads ahead once a refetch that was in the way on open has ended', async () => {
    serve(220);
    const { result } = renderTranscript();
    await opened(result);
    api.hold();
    let refreshed: Promise<void> = Promise.resolve();
    act(() => {
      refreshed = result.current.queryClient.invalidateQueries({
        queryKey: messageKeys.list(CHAT_ID),
      });
    });
    await waitFor(() => expect(result.current.queryClient.isFetching()).toBe(1));

    await idle.runIdle();
    expectOlderRequests(0);

    api.release();
    await act(async () => {
      await refreshed;
    });
    await waitFor(() =>
      expect(`idle callbacks waiting: ${idle.pending}`).toBe('idle callbacks waiting: 1')
    );
    await idle.runIdle();
    await waitFor(() => expectOlderRequests(1));
  });

  it('stays at that one page however long the reader stays put', async () => {
    serve(220);
    const { result } = renderTranscript();
    await opened(result);
    await idle.runIdle();
    await waitFor(() => expect(result.current.messages).toHaveLength(100));

    await idle.runIdle();
    await idle.runIdle();

    expectOlderRequests(1);
    expect(`idle callbacks waiting: ${idle.pending}`).toBe('idle callbacks waiting: 0');
  });

  it('grows the buffer once the reader scrolls up into the older page', async () => {
    serve(220);
    const { result } = renderTranscript();
    await opened(result);
    await idle.runIdle();
    await waitFor(() => expect(result.current.messages).toHaveLength(100));

    await scrollUpIntoOlderPage(40);

    await waitFor(() => expectTranscript(result.current.messages, 'msg-071 .. msg-220 (150)'));
    expectOlderRequests(2);
  });

  it('fetches nothing for a chat that fits one page', async () => {
    serve(30);
    const { result } = renderTranscript();
    await opened(result);

    expect(`idle callbacks waiting: ${idle.pending}`).toBe('idle callbacks waiting: 0');
    await scrollUpIntoOlderPage(0);
    expectOlderRequests(0);
  });

  it('fetches nothing while a turn is streaming', async () => {
    serve(220);
    const { result } = renderTranscript({ paused: true });
    await opened(result);

    await idle.runIdle();
    await scrollUpIntoOlderPage(0);

    expectOlderRequests(0);
  });
});

describe('read-ahead when the reader pauses', () => {
  it('drops the page the scroll window wanted, and asks for the same page again when the reader resumes', async () => {
    serve(220);
    const { result } = renderTranscript();
    await opened(result);
    await idle.runIdle();
    await waitFor(() => expect(result.current.messages).toHaveLength(100));
    api.holdOlder();

    await scrollUpIntoOlderPage(40);
    await waitFor(() => expectOlderRequests(2));
    // The reader stops: the page nobody is waiting for is aborted.
    await waitFor(() => expect(`aborted: ${api.aborted.length}`).toBe('aborted: 1'), {
      timeout: 3_000,
    });
    expectTranscript(result.current.messages, 'msg-121 .. msg-220 (100)');

    await scrollUpIntoOlderPage(40);
    await waitFor(() => expectOlderRequests(3));

    const cursors = api.olderRequests.map((request) => new URL(request, 'http://x').search);
    expect(
      `pages asked: ${cursors.at(-1) === cursors.at(-2) ? 'the same page again' : 'a different page'}`
    ).toBe('pages asked: the same page again');
  });
});

describe('read-ahead is additive', () => {
  it('opens on the newest messages, and stays usable, with the read-ahead request held open forever', async () => {
    serve(220);
    api.holdOlder();
    const { result } = renderTranscript();
    await opened(result);
    await idle.runIdle();
    await waitFor(() => expectOlderRequests(1));

    expectTranscript(result.current.messages, 'msg-171 .. msg-220 (50)');
    expect(`status: ${result.current.status}`).toBe('status: success');
    expect(`loading older: ${result.current.older.isLoading}`).toBe('loading older: false');
    expect(`older failed: ${result.current.older.failed}`).toBe('older failed: false');

    // Sending still works: the optimistic row appears at the end of the transcript.
    act(() => {
      result.current.optimistic.appendOptimisticMessages(CHAT_ID, [
        { ...FakeTranscriptApi.messageAt(CHAT_ID, 221), id: 'optimistic-1', text: 'sending' },
      ]);
    });
    await waitFor(() => {
      expect(`last message: ${result.current.messages.at(-1)?.text}`).toBe('last message: sending');
    });
    expect(`loading older: ${result.current.older.isLoading}`).toBe('loading older: false');
  });

  it('shows the read-ahead as loading only once the reader is waiting on it', async () => {
    serve(220);
    api.holdOlder();
    const { result } = renderTranscript();
    await opened(result);
    await idle.runIdle();
    await waitFor(() => expectOlderRequests(1));
    expect(`loading older: ${result.current.older.isLoading}`).toBe('loading older: false');

    // The reader reaches the top of what is loaded while the page is in flight.
    act(() => {
      result.current.older.load();
    });
    await waitFor(() => expect(result.current.older.isLoading).toBe(true));
    expectOlderRequests(1);

    api.release();
    await waitFor(() => expect(result.current.messages).toHaveLength(100));
    await waitFor(() => expect(result.current.older.isLoading).toBe(false));
  });

  it('keeps a message sent while the read-ahead page was in flight', async () => {
    serve(220);
    api.holdOlder();
    const { result } = renderTranscript();
    await opened(result);
    await idle.runIdle();
    await waitFor(() => expectOlderRequests(1));

    act(() => {
      result.current.optimistic.appendOptimisticMessages(CHAT_ID, [
        { ...FakeTranscriptApi.messageAt(CHAT_ID, 221), id: 'optimistic-1', text: 'sending' },
      ]);
    });
    api.release();

    await waitFor(() => expect(result.current.messages).toHaveLength(101));
    expect(`last message: ${result.current.messages.at(-1)?.text}`).toBe('last message: sending');
    expect(`first message: ${result.current.messages[0]?.text}`).toBe('first message: msg-121');
  });

  it.each([429, 500])(
    'shows no error and asks no more after a read-ahead answered %d, and scrolling up still loads',
    async (status) => {
      serve(220);
      api.refuseOlder(status);
      const { result } = renderTranscript();
      await opened(result);
      await idle.runIdle();
      await waitFor(() => expectOlderRequests(1));
      await waitFor(() => expect(result.current.queryClient.isFetching()).toBe(0));

      expect(`status: ${result.current.status}`).toBe('status: success');
      expect(`older failed: ${result.current.older.failed}`).toBe('older failed: false');
      expect(`loading older: ${result.current.older.isLoading}`).toBe('loading older: false');
      expectTranscript(result.current.messages, 'msg-171 .. msg-220 (50)');

      // No retry, and no further read-ahead however often the reader scrolls.
      await scrollUpIntoOlderPage(0);
      await idle.runIdle();
      expectOlderRequests(1);

      // The reader's own ask is untouched, and loads the page once the hub recovers.
      api.stopRefusing();
      act(() => {
        result.current.older.load();
      });
      await waitFor(() => expectTranscript(result.current.messages, 'msg-121 .. msg-220 (100)'));
      expectOlderRequests(2);
    }
  );

  it('keeps the reader fetch failing visible: a refused page the reader asked for is a failure', async () => {
    serve(220);
    const { result } = renderTranscript();
    await opened(result);
    api.refuseOlder(429);

    act(() => {
      result.current.older.load();
    });

    await waitFor(() => expect(result.current.older.failed).toBe(true));
  });
});

describe('a reader who joins a read-ahead that then fails', () => {
  it('sees the failure and can ask again, instead of waiting at the top with nothing shown', async () => {
    serve(220);
    api.holdOlder();
    api.refuseOlder(429);
    const { result } = renderTranscript();
    await opened(result);
    await idle.runIdle();
    await waitFor(() => expectOlderRequests(1));

    // The reader reaches the top while the read-ahead page is still in flight...
    act(() => {
      result.current.older.load();
    });
    await waitFor(() => expect(result.current.older.isLoading).toBe(true));

    // ...and the hub refuses it: this is the reader's page now, so it is a failure.
    api.release();
    await waitFor(() =>
      expect(`older failed: ${result.current.older.failed}`).toBe('older failed: true')
    );
    expect(`loading older: ${result.current.older.isLoading}`).toBe('loading older: false');

    // Scrolling asks again, and the page loads once the hub recovers.
    api.stopRefusing();
    act(() => {
      result.current.older.load();
    });
    await waitFor(() => expectTranscript(result.current.messages, 'msg-121 .. msg-220 (100)'));
  });
});

describe('read-ahead ends with the transcript', () => {
  it('aborts the page in flight when the transcript unmounts, and asks for nothing more', async () => {
    serve(220);
    api.holdOlder();
    const view = renderTranscript();
    await opened(view.result);
    await idle.runIdle();
    await waitFor(() => expectOlderRequests(1));

    view.unmount();

    await waitFor(() => expect(`aborted: ${api.aborted.length}`).toBe('aborted: 1'));
    api.release();
    await idle.runIdle();
    expectOlderRequests(1);
    expect(`idle callbacks waiting: ${idle.pending}`).toBe('idle callbacks waiting: 0');
  });

  it('aborts the page in flight on a chat switch and fetches the next chat on its own schedule', async () => {
    serve(220);
    api.alsoServe('chat-2', 220);
    api.holdOlder();
    const view = renderTranscript();
    await opened(view.result);
    await idle.runIdle();
    await waitFor(() => expectOlderRequests(1));

    view.rerender({ chatId: 'chat-2', paused: false });

    await waitFor(() => expect(`aborted: ${api.aborted.length}`).toBe('aborted: 1'));
    await waitFor(() => expect(view.result.current.status).toBe('success'));
    // Nothing of chat-2 is fetched ahead until the browser is idle again.
    expect(
      `older requests for chat-2: ${api.olderRequests.filter((r) => r.includes('chat-2')).length}`
    ).toBe('older requests for chat-2: 0');
    expect(`idle callbacks waiting: ${idle.pending}`).toBe('idle callbacks waiting: 1');
  });

  it('leaves the aborted chat as it was, with no error', async () => {
    serve(220);
    api.alsoServe('chat-2', 220);
    api.holdOlder();
    const view = renderTranscript();
    await opened(view.result);
    await idle.runIdle();
    await waitFor(() => expectOlderRequests(1));
    view.rerender({ chatId: 'chat-2', paused: false });
    await waitFor(() => expect(`aborted: ${api.aborted.length}`).toBe('aborted: 1'));

    const state = view.result.current.queryClient.getQueryState(messageKeys.list(CHAT_ID));
    expect(`chat-1 query: ${state?.status} / ${state?.fetchStatus}`).toBe(
      'chat-1 query: success / idle'
    );
  });
});

describe('a refresh after a turn with read-ahead buffered pages', () => {
  /** Opened, read ahead once while idle, then once more as the reader scrolled up: 3 pages. */
  async function bufferedThreePages() {
    serve(220);
    const view = renderTranscript();
    await opened(view.result);
    await idle.runIdle();
    await waitFor(() => expect(view.result.current.messages).toHaveLength(100));
    await scrollUpIntoOlderPage(10);
    await waitFor(() => expect(view.result.current.messages).toHaveLength(150));
    await waitFor(() => expect(view.result.current.queryClient.isFetching()).toBe(0));
    return view;
  }

  const refresh = (view: Awaited<ReturnType<typeof bufferedThreePages>>) =>
    view.result.current.queryClient.invalidateQueries({ queryKey: messageKeys.list(CHAT_ID) });

  it('still costs the newest page and one behind it', async () => {
    const view = await bufferedThreePages();
    api.appendMessage();
    api.appendMessage();
    const before = api.requests.length;

    await act(async () => {
      await refresh(view);
    });

    await waitFor(() => expect(view.result.current.messages.at(-1)?.text).toBe('msg-222'));
    expect(`requests to refresh 3 buffered pages: ${api.requests.length - before}`).toBe(
      'requests to refresh 3 buffered pages: 2'
    );
    expect(`rows kept: ${view.result.current.messages.length}`).toBe('rows kept: 152');
  });

  it('cancels a read-ahead in flight when the transcript refetches, and stays consistent', async () => {
    const view = await bufferedThreePages();
    api.holdOlder();
    await scrollUpIntoOlderPage(10);
    await waitFor(() => expectOlderRequests(3));
    api.appendMessage();
    const before = api.requests.length;

    // The refetch's second page is held with the read-ahead; both are let through together.
    let refreshed: Promise<void> = Promise.resolve();
    act(() => {
      refreshed = refresh(view);
    });
    await waitFor(() => expect(api.requests.length - before).toBeGreaterThan(0));
    api.release();
    await act(async () => {
      await refreshed;
    });

    await waitFor(() => expect(view.result.current.messages.at(-1)?.text).toBe('msg-221'));
    expect(
      `requests to refresh with a page in flight: ${api.requests.length - before}`,
      'expected the refresh to cost the newest page and one behind it: 2'
    ).toBe('requests to refresh with a page in flight: 2');
    const texts = view.result.current.messages.map((message) => Number(message.text.slice(4)));
    const broken = texts.findIndex(
      (value, index) => index > 0 && value !== (texts[index - 1] ?? 0) + 1
    );
    expect(`gap in transcript at: ${broken}`).toBe('gap in transcript at: -1');
  });
});
