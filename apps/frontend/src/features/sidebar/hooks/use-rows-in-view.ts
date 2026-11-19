import { type RefObject, useEffect, useRef } from 'react';

/** The attribute a row carries to be watched; its value is the id reported. */
export const ROW_IN_VIEW_ATTRIBUTE = 'data-row-in-view-id';

/**
 * How far past the scroll container's edges a row still counts as in view, so
 * the next few rows already have their data when they scroll in. About seven
 * 32px chat rows each way.
 */
export const ROWS_IN_VIEW_MARGIN_PX = 240;

/**
 * How long the window must hold still before it is reported. A drag of the
 * scrollbar sweeps hundreds of rows past the viewport in a second; reporting
 * each step would request data for rows nobody stopped on.
 */
export const ROWS_IN_VIEW_SETTLE_MS = 150;

interface RowsInViewOptions {
  /** The scroll container the rows live in. */
  readonly rootRef: RefObject<HTMLElement | null>;
  /**
   * Re-reads which rows exist when it changes. Rows come and go without the
   * container noticing (a new chat, a search filter), and a row that is added
   * is only watched once this changes.
   */
  readonly rowsKey: unknown;
  /** Receives the sorted ids of the rows in view, only when that set changes. */
  readonly onChange: (ids: readonly string[]) => void;
  readonly settleMs?: number;
}

/**
 * Reports which of the container's rows are in its scroll window, plus
 * {@link ROWS_IN_VIEW_MARGIN_PX} of lookahead, once the window stops moving.
 *
 * Rows opt in with {@link ROW_IN_VIEW_ATTRIBUTE}. Without `IntersectionObserver`
 * every opted-in row is reported, which is the behavior of a list that cannot
 * measure itself rather than a list that shows nothing.
 *
 * @example
 * useRowsInView({ rootRef: navRef, rowsKey: groups, onChange: setIdsInView });
 */
export function useRowsInView({
  rootRef,
  rowsKey,
  onChange,
  settleMs = ROWS_IN_VIEW_SETTLE_MS,
}: RowsInViewOptions): void {
  // Read through a ref so a new callback identity does not tear the observer
  // down and re-report a window that has not moved.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Survives the effect re-running: a re-sync that lands on the same window
  // must stay silent.
  const lastReportedRef = useRef<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const report = (ids: ReadonlySet<string>) => {
      const sorted = [...ids].sort();
      const signature = sorted.join('\0');
      if (signature === lastReportedRef.current) return;
      lastReportedRef.current = signature;
      onChangeRef.current(sorted);
    };

    const rows = [...root.querySelectorAll<HTMLElement>(`[${ROW_IN_VIEW_ATTRIBUTE}]`)];
    const idOf = (row: Element) => row.getAttribute(ROW_IN_VIEW_ATTRIBUTE) ?? '';

    if (rows.length === 0 || typeof IntersectionObserver === 'undefined') {
      report(new Set(rows.map(idOf)));
      return;
    }

    // Rebuilt on every run, so a row that has gone away drops out; the new
    // observer reports every row it watches once, in view or not.
    const inView = new Set<string>();
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = idOf(entry.target);
          if (entry.isIntersecting) inView.add(id);
          else inView.delete(id);
        }
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => report(inView), settleMs);
      },
      { root, rootMargin: `${ROWS_IN_VIEW_MARGIN_PX}px 0px` }
    );
    for (const row of rows) observer.observe(row);

    return () => {
      observer.disconnect();
      if (settleTimer !== null) clearTimeout(settleTimer);
    };
  }, [rootRef, rowsKey, settleMs]);
}
