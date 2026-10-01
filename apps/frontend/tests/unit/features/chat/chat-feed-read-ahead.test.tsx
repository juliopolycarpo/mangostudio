/**
 * ChatFeed with real read-ahead: older pages arrive ahead of the reader without
 * the loading indicator ever showing, and the indicator still shows for a reader
 * who really is waiting.
 *
 * The feed, the transcript hook and the virtualizer are real; the hub is a fake
 * that pages like the route, the layout engine is `FakeTranscriptLayout`, and
 * the browser's idle callback is a named fake.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { FakeTranscriptLayout } from '../../../support/harness/fake-transcript-layout';
import { act, fireEvent, render, waitFor } from '../../../support/harness/render';
import { FakeIdleScheduler } from '../../../support/mocks/fake-idle-scheduler';
import { FakeTranscriptApi } from '../../../support/mocks/fake-transcript-api';

const { ChatFeed } = await import('../../../../src/features/chat/components/ChatFeed');
const { messageKeys } = await import('../../../../src/features/chat/queries');
const { useChatPageMessages } = await import(
  '../../../../src/features/chat/hooks/use-chat-page-state'
);

const CHAT_ID = 'chat-1';

let layout: FakeTranscriptLayout;
let idle: FakeIdleScheduler;
let api: FakeTranscriptApi;
/** The query client the feed under test runs on, for a test that refetches. */
const captured: { queryClient?: QueryClient; busy?: boolean } = {};

beforeEach(() => {
  layout = new FakeTranscriptLayout();
  layout.install();
  idle = new FakeIdleScheduler().install();
});

afterEach(() => {
  api?.restore();
  idle.restore();
  layout.uninstall();
});

/** What the chat page does: the transcript query feeding the feed. */
function TranscriptFeed({ isGenerating = false }: { isGenerating?: boolean }) {
  const { messages, older, status } = useChatPageMessages({ chatId: CHAT_ID });
  captured.queryClient = useQueryClient();
  captured.busy = older.ahead?.busy ?? false;
  if (status !== 'success') return null;
  return (
    <ChatFeed chatId={CHAT_ID} messages={messages} older={older} isGenerating={isGenerating} />
  );
}

async function openTranscript(total: number, options: { isGenerating?: boolean } = {}) {
  api = new FakeTranscriptApi({ chatId: CHAT_ID, total }).install();
  const view = render(<TranscriptFeed isGenerating={options.isGenerating} />);
  const port = await waitFor(() => {
    const found = view.container.querySelector('section');
    if (!found) throw new Error('expected the transcript feed | received none');
    return found;
  });
  layout.settle(port);
  await waitFor(() => {
    layout.settle(port);
    expect(`newest message shown: ${port.textContent?.includes('msg-220')}`).toBe(
      'newest message shown: true'
    );
  });
  return { ...view, port };
}

/**
 * Polls `check` on plain timers until it passes, or fails with its last error.
 *
 * Used instead of Testing Library's `waitFor` for the wait after a held hub
 * response is released: measured with this feed's fake layout installed, its
 * polling did not run until its own timeout, while plain timers do.
 */
async function eventually(check: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

/** What the reader sees of the loading indicator, as a one-line assertion subject. */
function indicator(queryByText: (text: string) => HTMLElement | null): string {
  return `loading indicator: ${queryByText(en.chat.feed.loadingOlder) ? 'shown' : 'none'}`;
}

/** Records whether the loading indicator was ever in the document. */
class IndicatorWatch {
  seen = false;
  private readonly observer = new MutationObserver(() => this.check());

  constructor(private readonly root: HTMLElement) {
    this.observer.observe(root, { childList: true, subtree: true, characterData: true });
    this.check();
  }

  private check() {
    if (this.root.textContent?.includes(en.chat.feed.loadingOlder)) this.seen = true;
  }

  stop(): void {
    this.check();
    this.observer.disconnect();
  }
}

describe('ChatFeed read-ahead is additive', () => {
  it('opens on the newest messages with no loading indicator, with the read-ahead request held open forever', async () => {
    const { port, queryByText } = await openTranscript(220);
    api.holdOlder();

    await idle.runIdle();
    await waitFor(() =>
      expect(`older requests: ${api.olderRequests.length}`).toBe('older requests: 1')
    );
    layout.settle(port);

    expect(`newest message shown: ${port.textContent?.includes('msg-220')}`).toBe(
      'newest message shown: true'
    );
    expect(indicator(queryByText)).toBe('loading indicator: none');
  });

  it('never shows the indicator while a read-ahead page is fetched and lands', async () => {
    const { port, container } = await openTranscript(220);
    api.holdOlder();
    const watch = new IndicatorWatch(container);

    await idle.runIdle();
    await waitFor(() =>
      expect(`older requests: ${api.olderRequests.length}`).toBe('older requests: 1')
    );
    api.release();
    await waitFor(() => {
      layout.settle(port);
      expect(port.textContent?.includes('msg-220')).toBe(true);
      expect(api.requests.length).toBeGreaterThan(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    watch.stop();

    expect(`indicator ever shown: ${watch.seen}`).toBe('indicator ever shown: false');
  });

  it('shows the indicator when the reader reaches the top while the page is still in flight', async () => {
    const { port, queryByText } = await openTranscript(220);
    api.holdOlder();
    await idle.runIdle();
    await waitFor(() =>
      expect(`older requests: ${api.olderRequests.length}`).toBe('older requests: 1')
    );
    expect(indicator(queryByText)).toBe('loading indicator: none');

    fireEvent.wheel(port, { deltaY: -400 });
    port.scrollTop = 0;
    layout.flushFrame(port);

    await waitFor(() => expect(indicator(queryByText)).toBe('loading indicator: shown'));
    expect(`older requests: ${api.olderRequests.length}`).toBe('older requests: 1');

    api.release();
    await eventually(() => expect(indicator(queryByText)).toBe('loading indicator: none'));
  });

  it('fetches nothing ahead while a turn is generating', async () => {
    await openTranscript(220, { isGenerating: true });

    await idle.runIdle();

    expect(`older requests: ${api.olderRequests.length}`).toBe('older requests: 0');
    expect(`idle callbacks waiting: ${idle.pending}`).toBe('idle callbacks waiting: 0');
  });

  it('asks for the older page again when a refetch that was in the way ends with the reader at the top', async () => {
    const { port } = await openTranscript(220);
    await idle.runIdle();
    await waitFor(() =>
      expect(`older requests: ${api.olderRequests.length}`).toBe('older requests: 1')
    );
    await eventually(() => expect(captured.queryClient?.isFetching()).toBe(0));
    const queryClient = captured.queryClient as QueryClient;

    // A refetch is running when the reader reaches the top: the ask has to wait.
    api.hold();
    act(() => {
      void queryClient.invalidateQueries({ queryKey: messageKeys.list(CHAT_ID) });
    });
    await eventually(() =>
      expect(`feed sees a fetch: ${captured.busy}`).toBe('feed sees a fetch: true')
    );
    port.scrollTop = 0;
    fireEvent.wheel(port, { deltaY: -400 });
    layout.flushFrame(port);
    expect(`older requests: ${api.olderRequests.length}`).toBe('older requests: 1');

    // When it ends, the reader is still at the top and the page is asked for
    // without another gesture.
    api.release();
    await eventually(() =>
      expect(`older requests: ${api.olderRequests.length}`).toBe('older requests: 2')
    );
  });
});
