import { type RefObject, useCallback, useEffect, useRef } from 'react';
import {
  READ_AHEAD_IDLE_PAGES,
  READ_AHEAD_IDLE_TIMEOUT_MS,
  READ_AHEAD_SCROLL_ACTIVE_MS,
  READ_AHEAD_SCROLL_TIMEOUT_MS,
  type ReaderPosition,
  scheduleIdle,
  wantsOlderPage,
} from '../transcript-read-ahead';
import { GESTURE_EVENTS, GESTURE_WINDOW_MS } from './use-chat-auto-follow';
import type { OlderMessages } from './use-chat-page-state';

interface UseTranscriptReadAheadParams {
  readonly chatId: string | null;
  /** The newest page has rendered and the view is positioned on it. */
  readonly ready: boolean;
  /** A turn is streaming: nothing is started while it is. */
  readonly paused: boolean;
  readonly older: OlderMessages | undefined;
  readonly parentRef: RefObject<HTMLElement | null>;
  /** Where the reader is, read at the moment of asking. */
  readonly readPosition: () => ReaderPosition;
}

/**
 * Keeps older transcript pages loaded ahead of the reader, one at a time, each
 * started when the browser is idle.
 *
 * Idle, it keeps `READ_AHEAD_IDLE_PAGES` pages behind the newest one. While the
 * reader scrolls up it keeps `READ_AHEAD_SCROLL_PAGES` above their own page,
 * topping the buffer up as they go (see `wantsOlderPage`). When they stop it
 * drops a fetch that only the scroll window wanted, and it starts nothing while
 * a turn streams or once the oldest message is loaded.
 *
 * It never touches what the reader sees: the pages are fetched through
 * `older.ahead`, which neither shows the loading indicator nor an error.
 *
 * @example
 * useTranscriptReadAhead({ chatId, ready, paused: isStreaming, older, parentRef, readPosition });
 */
export function useTranscriptReadAhead({
  chatId,
  ready,
  paused,
  older,
  parentRef,
  readPosition,
}: UseTranscriptReadAheadParams): void {
  const ahead = older?.ahead;
  const hasMore = older?.hasMore ?? false;
  const active = ready && !paused && ahead !== undefined && hasMore;
  const layout = ahead?.pageSizes.join(',');
  const busy = ahead?.busy ?? false;

  // What the idle callbacks and listeners below read when they fire.
  const latest = useRef({ ahead, hasMore, active, readPosition });
  useEffect(() => {
    latest.current = { ahead, hasMore, active, readPosition };
  }, [ahead, hasMore, active, readPosition]);

  // The ask waiting for the browser to be idle, and how long it may wait.
  const pendingRef = useRef<{ cancel: () => void; timeoutMs: number } | null>(null);
  const scrollingUntilRef = useRef(0);
  const isScrolling = useCallback(() => performance.now() < scrollingUntilRef.current, []);

  const evaluate = useCallback(() => {
    const current = latest.current;
    if (!current.active || !current.ahead) return;
    const wanted = wantsOlderPage({
      hasMore: current.hasMore,
      scrolling: isScrolling(),
      pageSizes: current.ahead.pageSizes,
      position: current.readPosition(),
    });
    if (wanted) current.ahead.start();
  }, [isScrolling]);

  const schedule = useCallback(() => {
    const timeoutMs = isScrolling() ? READ_AHEAD_SCROLL_TIMEOUT_MS : READ_AHEAD_IDLE_TIMEOUT_MS;
    // One ask waits at a time; a reader who starts scrolling shortens its wait.
    if (pendingRef.current && pendingRef.current.timeoutMs <= timeoutMs) return;
    pendingRef.current?.cancel();
    const cancel = scheduleIdle(() => {
      pendingRef.current = null;
      evaluate();
    }, timeoutMs);
    pendingRef.current = { cancel, timeoutMs };
  }, [evaluate, isScrolling]);

  // A new chat starts as an idle reader, whatever the last one was doing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `chatId` is the trigger
  useEffect(() => {
    scrollingUntilRef.current = 0;
  }, [chatId]);

  // The opening window, and the refill after every page that lands: this runs
  // again whenever the loaded pages change, and when a fetch that was in the way
  // (a refetch on open, say) ends. Leaving (a switch, a stream
  // starting, unmount) cancels the one waiting to run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `chatId`, `layout` and `busy` are what re-arm it
  useEffect(() => {
    if (!active) return;
    schedule();
    return () => {
      pendingRef.current?.cancel();
      pendingRef.current = null;
    };
  }, [chatId, active, layout, busy, schedule]);

  // The reader scrolling up: only an upward movement a gesture drove counts,
  // so rows measuring or a page landing above them (which move `scrollTop`
  // without the reader) never open the scroll window.
  useEffect(() => {
    const port = parentRef.current;
    if (!port) return;
    let lastScrollTop = port.scrollTop;
    let lastGestureAt = Number.NEGATIVE_INFINITY;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;

    const dropWhenStopped = () => {
      const { ahead: handle } = latest.current;
      if (!handle?.isRunning() || handle.pageSizes.length - 1 < READ_AHEAD_IDLE_PAGES) return;
      handle.abort();
    };
    const scrollingUp = () => {
      scrollingUntilRef.current = performance.now() + READ_AHEAD_SCROLL_ACTIVE_MS;
      clearTimeout(stopTimer);
      stopTimer = setTimeout(dropWhenStopped, READ_AHEAD_SCROLL_ACTIVE_MS);
      schedule();
    };
    const onGesture = (event: Event) => {
      lastGestureAt = performance.now();
      if (event.type === 'wheel' && (event as WheelEvent).deltaY < 0) scrollingUp();
    };
    const onScroll = () => {
      const top = port.scrollTop;
      const movedUp = top < lastScrollTop - 1;
      lastScrollTop = top;
      if (!movedUp || performance.now() - lastGestureAt >= GESTURE_WINDOW_MS) return;
      lastGestureAt = performance.now();
      scrollingUp();
    };

    for (const name of GESTURE_EVENTS) port.addEventListener(name, onGesture, { passive: true });
    port.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(stopTimer);
      for (const name of GESTURE_EVENTS) port.removeEventListener(name, onGesture);
      port.removeEventListener('scroll', onScroll);
    };
  }, [parentRef, schedule]);
}
