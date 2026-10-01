/**
 * Read-ahead for the chat transcript: how many older pages are kept loaded
 * above the reader, and when one more is worth asking for.
 *
 * Read-ahead is an optimisation layered over the on-demand paging in
 * `transcript-pages.ts`: nothing depends on it. The pages it fetches are the
 * pages the reader would have asked for by scrolling, so an unfetched, failed
 * or cancelled read-ahead only means the reader's own scroll asks instead.
 */

/**
 * Older pages kept loaded below the newest one while the reader is idle: the
 * chat has opened, the newest page has rendered, nobody has scrolled yet.
 */
export const READ_AHEAD_IDLE_PAGES = 1;

/**
 * Older pages kept loaded above the reader's own page while they scroll up.
 * Raise to 3 to buffer further; nothing else depends on the number.
 */
export const READ_AHEAD_SCROLL_PAGES = 2;

/**
 * The reader is "nearing the top" of what is loaded when this many viewports
 * of rows or fewer remain above the view.
 */
export const READ_AHEAD_VIEWPORTS_ABOVE = 2;

/**
 * How long the reader counts as still scrolling after their last upward
 * movement. Past it the scroll window collapses back to the idle one and a page
 * nobody is waiting on is dropped.
 */
export const READ_AHEAD_SCROLL_ACTIVE_MS = 600;

/** The longest an idle read-ahead may wait for the browser to be idle. */
export const READ_AHEAD_IDLE_TIMEOUT_MS = 2_000;

/** The same wait while the reader is scrolling: the next page is wanted soon. */
export const READ_AHEAD_SCROLL_TIMEOUT_MS = 250;

/** Where no idle callback exists (Safari, happy-dom) a plain timer stands in. */
const FALLBACK_IDLE_DELAY_MS = 200;

type IdleHost = {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Runs `callback` when the browser is idle, at the latest after `timeoutMs`
 * (`requestIdleCallback`), or after a short timer where there is no idle
 * callback. Returns the function that cancels it.
 *
 * @example
 * const cancel = scheduleIdle(() => prefetch(), 2_000);
 * cancel(); // before it ran: it never will
 */
export function scheduleIdle(callback: () => void, timeoutMs: number): () => void {
  const host = globalThis as IdleHost;
  if (typeof host.requestIdleCallback === 'function') {
    const handle = host.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => host.cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(callback, Math.min(timeoutMs, FALLBACK_IDLE_DELAY_MS));
  return () => clearTimeout(handle);
}

/** Where the reader is in the loaded transcript. */
export interface ReaderPosition {
  /** Index in the flattened transcript of the first row in view. */
  readonly firstVisibleIndex: number;
  /** Pixels of loaded transcript above the view. */
  readonly offsetPx: number;
  readonly viewportPx: number;
}

/**
 * How many loaded pages lie wholly above the page the reader is in.
 * `pageSizes` is the row count of each loaded page, oldest page first.
 *
 * @example
 * olderPagesAbove([50, 50, 50], 120); // => 2 (the reader is in the newest page)
 */
export function olderPagesAbove(pageSizes: readonly number[], firstVisibleIndex: number): number {
  let end = 0;
  for (const [index, size] of pageSizes.entries()) {
    end += size;
    if (firstVisibleIndex < end) return index;
  }
  return Math.max(0, pageSizes.length - 1);
}

/**
 * Whether one more older page should be fetched in the background now.
 *
 * - Always: fewer than `READ_AHEAD_IDLE_PAGES` older pages are loaded.
 * - While the reader scrolls up: fewer than `READ_AHEAD_SCROLL_PAGES` pages lie
 *   above their own page, and they have either crossed into an older page or
 *   are within `READ_AHEAD_VIEWPORTS_ABOVE` viewports of the top of what is
 *   loaded. Scrolling inside the newest page with a page buffered behind it
 *   asks for nothing: that buffer is still far away.
 *
 * @example
 * wantsOlderPage({ hasMore: true, scrolling: false, pageSizes: [50], position });
 * // => true: the newest page is the only one loaded
 */
export function wantsOlderPage(input: {
  readonly hasMore: boolean;
  readonly scrolling: boolean;
  /** Row count of each loaded page, oldest page first. */
  readonly pageSizes: readonly number[];
  readonly position: ReaderPosition;
}): boolean {
  const { hasMore, scrolling, pageSizes, position } = input;
  if (!hasMore || pageSizes.length === 0) return false;
  if (pageSizes.length - 1 < READ_AHEAD_IDLE_PAGES) return true;
  if (!scrolling) return false;

  const above = olderPagesAbove(pageSizes, position.firstVisibleIndex);
  if (above >= READ_AHEAD_SCROLL_PAGES) return false;
  const crossed = above < pageSizes.length - 1;
  const nearTop = position.offsetPx <= READ_AHEAD_VIEWPORTS_ABOVE * position.viewportPx;
  return crossed || nearTop;
}

/**
 * A background fetch of one older page, as the query's persister sees it.
 * Aborting `controller` ends the request; `failed` is set when it did not
 * complete for any other reason. `readerWaiting` is set when the reader reached
 * the top while the page was in flight: the page is theirs now, so a failure is
 * theirs to see and retry, not a background one to swallow.
 */
export interface BackgroundRun {
  readonly controller: AbortController;
  failed: boolean;
  readerWaiting: boolean;
}

const pendingRuns = new WeakMap<object, BackgroundRun>();

/** Marks the next older-page fetch of `query` as a background one. */
export function registerBackgroundRun(query: object, run: BackgroundRun): void {
  pendingRuns.set(query, run);
}

/** Claims the background run registered for `query`, if its fetch is one. */
export function takeBackgroundRun(query: object): BackgroundRun | undefined {
  const run = pendingRuns.get(query);
  pendingRuns.delete(query);
  return run;
}

/** Forgets `run` when its fetch never claimed it (it joined another fetch, say). */
export function dropBackgroundRun(query: object, run: BackgroundRun): void {
  if (pendingRuns.get(query) === run) pendingRuns.delete(query);
}
