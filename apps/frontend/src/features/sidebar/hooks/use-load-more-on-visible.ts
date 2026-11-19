import { type RefObject, useEffect, useRef } from 'react';

import { ROWS_IN_VIEW_MARGIN_PX } from './use-rows-in-view';

/** The attribute the end-of-list sentinel carries, so a test can name it. */
export const LIST_END_ATTRIBUTE = 'data-chat-list-end';

interface LoadMoreOnVisibleOptions {
  /** The scroll container the sentinel lives in. */
  readonly rootRef: RefObject<HTMLElement | null>;
  /** The element at the end of the list; reaching it means the reader is out of rows. */
  readonly sentinelRef: RefObject<HTMLElement | null>;
  /** Whether another page may be asked for now; false while one loads or none remains. */
  readonly enabled: boolean;
  /**
   * Re-arms the observer when it changes. An observer only reports a change, so
   * a page that lands and leaves the sentinel in view would otherwise never ask
   * for the one after it.
   */
  readonly loadedKey: unknown;
  readonly onVisible: () => void;
}

/**
 * Calls `onVisible` when the sentinel is within {@link ROWS_IN_VIEW_MARGIN_PX}
 * of the container's scroll window, and again after each load that leaves it
 * there. Does nothing without `IntersectionObserver`: the list then keeps what
 * it has, and search still reads the rest.
 *
 * @example
 * useLoadMoreOnVisible({ rootRef: navRef, sentinelRef, enabled: hasMore, loadedKey: chats.length, onVisible: loadMore });
 */
export function useLoadMoreOnVisible({
  rootRef,
  sentinelRef,
  enabled,
  loadedKey,
  onVisible,
}: LoadMoreOnVisibleOptions): void {
  // Read through a ref so a new callback identity does not rebuild the observer.
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  useEffect(() => {
    const root = rootRef.current;
    const sentinel = sentinelRef.current;
    if (!enabled || !root || !sentinel || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onVisibleRef.current();
      },
      { root, rootMargin: `${ROWS_IN_VIEW_MARGIN_PX}px 0px` }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [rootRef, sentinelRef, enabled, loadedKey]);
}
