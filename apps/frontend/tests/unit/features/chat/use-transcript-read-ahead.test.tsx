/**
 * `useTranscriptReadAhead`: when the feed asks for older pages ahead of the
 * reader. The handle it asks through and the browser's idle callback are named
 * fakes, so each test decides what the transcript holds and when the browser is
 * idle; the fetching itself is covered by `transcript-read-ahead-query.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ReadAheadHandle } from '../../../../src/features/chat/hooks/use-chat-page-state';
import { fireEvent, renderHook } from '../../../support/harness/render';
import {
  advanceTimersByTimeAsync,
  restoreRealTimers,
  useFakeTimers,
} from '../../../support/harness/timers';
import { FakeIdleScheduler } from '../../../support/mocks/fake-idle-scheduler';

const { useTranscriptReadAhead } = await import(
  '../../../../src/features/chat/hooks/use-transcript-read-ahead'
);
const { READ_AHEAD_SCROLL_ACTIVE_MS } = await import(
  '../../../../src/features/chat/transcript-read-ahead'
);

const VIEWPORT = 800;
/** Far from the top of what is loaded, so only the page the reader is in matters. */
const FAR_FROM_TOP = 50_000;

/** What the transcript holds, and every ask made of it. */
class FakeReadAhead implements ReadAheadHandle {
  starts = 0;
  aborts = 0;
  running = false;
  busy = false;

  constructor(readonly pageSizes: readonly number[]) {}

  start = () => {
    this.starts++;
    return true;
  };
  abort = () => {
    this.aborts++;
  };
  isRunning = () => this.running;
}

interface Props {
  chatId: string;
  ready: boolean;
  paused: boolean;
  hasMore: boolean;
  ahead: FakeReadAhead;
}

const idleReader = { firstVisibleIndex: 0, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
let reader = idleReader;
let port: HTMLDivElement;
let idle: FakeIdleScheduler;

beforeEach(() => {
  idle = new FakeIdleScheduler().install();
  reader = idleReader;
  port = document.createElement('div');
  document.body.append(port);
});

afterEach(() => {
  idle.restore();
  port.remove();
});

function mount(initial: Partial<Props> & { ahead: FakeReadAhead }) {
  const props: Props = { chatId: 'a', ready: true, paused: false, hasMore: true, ...initial };
  return renderHook(
    (current: Props) =>
      useTranscriptReadAhead({
        chatId: current.chatId,
        ready: current.ready,
        paused: current.paused,
        older: {
          hasMore: current.hasMore,
          isLoading: false,
          failed: false,
          load: () => undefined,
          ahead: current.ahead,
        },
        parentRef: { current: port },
        readPosition: () => reader,
      }),
    { initialProps: props }
  );
}

function pendingCallbacks() {
  return `idle callbacks waiting: ${idle.pending}`;
}

describe('read-ahead on open', () => {
  it('asks for nothing until the newest page has rendered', () => {
    mount({ ahead: new FakeReadAhead([50]), ready: false });

    expect(pendingCallbacks()).toBe('idle callbacks waiting: 0');
  });

  it('asks for one older page once the browser is idle, not before', async () => {
    const ahead = new FakeReadAhead([50]);
    mount({ ahead });

    expect(`older pages asked before idle: ${ahead.starts}`).toBe(
      'older pages asked before idle: 0'
    );
    expect(pendingCallbacks()).toBe('idle callbacks waiting: 1');

    await idle.runIdle();
    expect(`older pages asked after idle: ${ahead.starts}`).toBe('older pages asked after idle: 1');
  });

  it('leaves the browser a bounded wait for idle', () => {
    mount({ ahead: new FakeReadAhead([50]) });

    expect(`idle timeout: ${idle.timeouts[0]}`).toBe('idle timeout: 2000');
  });

  it('stops at one older page when the reader has not scrolled', async () => {
    const ahead = new FakeReadAhead([50]);
    const view = mount({ ahead });
    await idle.runIdle();

    // The page landed: the transcript now holds the newest page and one older.
    const landed = new FakeReadAhead([50, 50]);
    view.rerender({ chatId: 'a', ready: true, paused: false, hasMore: true, ahead: landed });
    await idle.runIdle();

    expect(`older pages asked after the window filled: ${landed.starts}`).toBe(
      'older pages asked after the window filled: 0'
    );
  });

  it('asks again when the fetch that was in the way has ended', async () => {
    const inTheWay = new FakeReadAhead([50]);
    inTheWay.busy = true;
    const view = mount({ ahead: inTheWay });
    await idle.runIdle();
    expect(pendingCallbacks()).toBe('idle callbacks waiting: 0');

    const clear = new FakeReadAhead([50]);
    view.rerender({ chatId: 'a', ready: true, paused: false, hasMore: true, ahead: clear });

    expect(pendingCallbacks()).toBe('idle callbacks waiting: 1');
    await idle.runIdle();
    expect(`older pages asked once it was clear: ${clear.starts}`).toBe(
      'older pages asked once it was clear: 1'
    );
  });

  it('asks for nothing when the newest page is the whole chat', () => {
    mount({ ahead: new FakeReadAhead([30]), hasMore: false });

    expect(pendingCallbacks()).toBe('idle callbacks waiting: 0');
  });

  it('asks for nothing while a turn is streaming', () => {
    mount({ ahead: new FakeReadAhead([50]), paused: true });

    expect(pendingCallbacks()).toBe('idle callbacks waiting: 0');
  });

  it('cancels the ask waiting for idle when a turn starts streaming', async () => {
    const ahead = new FakeReadAhead([50]);
    const view = mount({ ahead });
    view.rerender({ chatId: 'a', ready: true, paused: true, hasMore: true, ahead });

    expect(pendingCallbacks()).toBe('idle callbacks waiting: 0');
    await idle.runIdle();
    expect(`older pages asked while streaming: ${ahead.starts}`).toBe(
      'older pages asked while streaming: 0'
    );
  });
});

describe('read-ahead while the reader scrolls up', () => {
  it('grows the buffer only after the reader scrolls up into an older page', async () => {
    const ahead = new FakeReadAhead([50, 50]);
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    mount({ ahead });
    await idle.runIdle();
    expect(`older pages asked before scrolling: ${ahead.starts}`).toBe(
      'older pages asked before scrolling: 0'
    );

    fireEvent.wheel(port, { deltaY: -120 });
    await idle.runIdle();

    expect(`older pages asked after scrolling up: ${ahead.starts}`).toBe(
      'older pages asked after scrolling up: 1'
    );
  });

  it('asks again as each page lands, until the scroll window is full', async () => {
    const first = new FakeReadAhead([50, 50]);
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    const view = mount({ ahead: first });
    fireEvent.wheel(port, { deltaY: -120 });
    await idle.runIdle();

    // One page landed above the reader: the same row is now at index 90, with one page above it.
    const second = new FakeReadAhead([50, 50, 50]);
    reader = { firstVisibleIndex: 90, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    view.rerender({ chatId: 'a', ready: true, paused: false, hasMore: true, ahead: second });
    await idle.runIdle();

    // Another landed: two pages above the reader, the window is full.
    const third = new FakeReadAhead([50, 50, 50, 50]);
    reader = { firstVisibleIndex: 140, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    view.rerender({ chatId: 'a', ready: true, paused: false, hasMore: true, ahead: third });
    await idle.runIdle();

    expect(
      `asked per step: ${first.starts},${second.starts},${third.starts}`,
      'expected asks per step: 1,1,0 (refill twice, then the window of 2 is full)'
    ).toBe('asked per step: 1,1,0');
  });

  it('waits less for idle while the reader is scrolling', () => {
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    mount({ ahead: new FakeReadAhead([50, 50]) });
    idle.timeouts.length = 0;

    fireEvent.wheel(port, { deltaY: -120 });

    expect(`idle timeout while scrolling: ${idle.timeouts[0]}`).toBe(
      'idle timeout while scrolling: 250'
    );
  });

  it('counts an upward scroll that a gesture drove', async () => {
    const ahead = new FakeReadAhead([50, 50]);
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    Object.defineProperty(port, 'scrollTop', { configurable: true, writable: true, value: 1_000 });
    mount({ ahead });
    await idle.runIdle();

    fireEvent.touchMove(port);
    port.scrollTop = 800;
    fireEvent.scroll(port);
    await idle.runIdle();

    expect(`older pages asked after a touch scroll up: ${ahead.starts}`).toBe(
      'older pages asked after a touch scroll up: 1'
    );
  });

  it('ignores a scroll no gesture drove, such as a page landing above the reader', async () => {
    const ahead = new FakeReadAhead([50, 50]);
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    Object.defineProperty(port, 'scrollTop', { configurable: true, writable: true, value: 1_000 });
    mount({ ahead });
    await idle.runIdle();

    port.scrollTop = 800;
    fireEvent.scroll(port);
    await idle.runIdle();

    expect(`older pages asked after an undriven scroll: ${ahead.starts}`).toBe(
      'older pages asked after an undriven scroll: 0'
    );
  });

  it('ignores a downward wheel', async () => {
    const ahead = new FakeReadAhead([50, 50]);
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    mount({ ahead });

    fireEvent.wheel(port, { deltaY: 120 });
    await idle.runIdle();

    expect(`older pages asked after a downward wheel: ${ahead.starts}`).toBe(
      'older pages asked after a downward wheel: 0'
    );
  });

  it('asks for nothing while a turn is streaming, even when the reader scrolls', async () => {
    const ahead = new FakeReadAhead([50, 50]);
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    mount({ ahead, paused: true });

    fireEvent.wheel(port, { deltaY: -120 });
    await idle.runIdle();

    expect(`older pages asked while streaming: ${ahead.starts}`).toBe(
      'older pages asked while streaming: 0'
    );
  });
});

describe('read-ahead when the reader stops', () => {
  afterEach(() => restoreRealTimers());

  it('drops a page only the scroll window wanted', async () => {
    useFakeTimers();
    const ahead = new FakeReadAhead([50, 50]);
    ahead.running = true;
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    mount({ ahead });

    fireEvent.wheel(port, { deltaY: -120 });
    await advanceTimersByTimeAsync(READ_AHEAD_SCROLL_ACTIVE_MS);

    expect(`aborts after the reader stopped: ${ahead.aborts}`).toBe(
      'aborts after the reader stopped: 1'
    );
  });

  it('keeps the page the idle window wants', async () => {
    useFakeTimers();
    const ahead = new FakeReadAhead([50]);
    ahead.running = true;
    mount({ ahead });

    fireEvent.wheel(port, { deltaY: -120 });
    await advanceTimersByTimeAsync(READ_AHEAD_SCROLL_ACTIVE_MS);

    expect(`aborts after the reader stopped: ${ahead.aborts}`).toBe(
      'aborts after the reader stopped: 0'
    );
  });

  it('does not drop anything while the reader keeps scrolling', async () => {
    useFakeTimers();
    const ahead = new FakeReadAhead([50, 50]);
    ahead.running = true;
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    mount({ ahead });

    fireEvent.wheel(port, { deltaY: -120 });
    await advanceTimersByTimeAsync(READ_AHEAD_SCROLL_ACTIVE_MS - 100);
    fireEvent.wheel(port, { deltaY: -120 });
    await advanceTimersByTimeAsync(READ_AHEAD_SCROLL_ACTIVE_MS - 100);

    expect(`aborts while still scrolling: ${ahead.aborts}`).toBe('aborts while still scrolling: 0');
  });
});

describe('leaving the transcript', () => {
  it('cancels the ask waiting for idle on unmount and schedules no more', async () => {
    const ahead = new FakeReadAhead([50, 50]);
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    const view = mount({ ahead });
    expect(pendingCallbacks()).toBe('idle callbacks waiting: 1');

    view.unmount();
    expect(pendingCallbacks()).toBe('idle callbacks waiting: 0');

    fireEvent.wheel(port, { deltaY: -120 });
    await idle.runIdle();
    expect(`older pages asked after unmount: ${ahead.starts}`).toBe(
      'older pages asked after unmount: 0'
    );
    expect(pendingCallbacks()).toBe('idle callbacks waiting: 0');
  });

  it('re-arms a single ask for the next chat on a switch', () => {
    const ahead = new FakeReadAhead([50]);
    const view = mount({ ahead });

    view.rerender({ chatId: 'b', ready: true, paused: false, hasMore: true, ahead });

    expect(pendingCallbacks()).toBe('idle callbacks waiting: 1');
  });

  it('does not carry the scroll window into the next chat', async () => {
    const ahead = new FakeReadAhead([50, 50]);
    reader = { firstVisibleIndex: 40, offsetPx: FAR_FROM_TOP, viewportPx: VIEWPORT };
    const view = mount({ ahead });
    fireEvent.wheel(port, { deltaY: -120 });
    await idle.runIdle();

    const next = new FakeReadAhead([50, 50]);
    view.rerender({ chatId: 'b', ready: true, paused: false, hasMore: true, ahead: next });
    await idle.runIdle();

    expect(`older pages asked for the next chat: ${next.starts}`).toBe(
      'older pages asked for the next chat: 0'
    );
  });
});
