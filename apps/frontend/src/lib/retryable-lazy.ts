import { type ComponentType, createElement, lazy, type ReactNode, useState } from 'react';

/**
 * What a `retryableLazy` import throws when its chunk cannot be fetched:
 * offline, or a 404 for a hashed name the hub no longer has after an upgrade
 * under an open tab (the hub then answers with HTML, which the browser also
 * refuses as a module).
 *
 * Its own class so a boundary can treat this failure, and only this one, as
 * "the code did not arrive". A chunk that arrived but threw while it ran is not
 * one: that is a bug no retry can fix, and it is rethrown as it was.
 */
export class LazyChunkLoadError extends Error {
  constructor(cause: unknown) {
    super(
      `Could not load a lazy component chunk: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = 'LazyChunkLoadError';
  }
}

// What each engine throws, as a TypeError, when a dynamic import cannot be
// fetched or is refused as a module:
//   Chromium  "Failed to fetch dynamically imported module: <url>"
//   Firefox   "error loading dynamically imported module: <url>"
//   WebKit    "Importing a module script failed."
//   Chromium, a static import inside the chunk: "Failed to load module script: ..."
// Anything else a module throws while it evaluates keeps its own type and text.
const CHUNK_FETCH_FAILURE =
  /dynamically imported module|importing a module script failed|failed to load module script/i;

/** True for the `TypeError` a browser raises when a dynamic import's chunk could not be fetched. */
// Usage: isChunkFetchFailure(new TypeError('Failed to fetch dynamically imported module: /a.js'))
export function isChunkFetchFailure(error: unknown): boolean {
  return error instanceof TypeError && CHUNK_FETCH_FAILURE.test(error.message);
}

export interface RetryableLazy<Props extends object> {
  /** Render this inside `Suspense` and a boundary for `LazyChunkLoadError`. */
  // A plain function type, not `ComponentType`: a panel that takes fewer props
  // than the registry hands it must stay assignable, as its eager form was.
  readonly Component: (props: Props) => ReactNode;
  /**
   * Starts the import without rendering anything, so a hover or focus can warm
   * the chunk before the click that needs it. Safe to call any number of times;
   * a failure is left for the render to report.
   */
  preload(): void;
  /**
   * Forgets a failed import so the next render fetches again, now. A user's
   * Retry calls this. `React.lazy` keeps a rejected promise for good, so without
   * it a retry would re-throw the first failure without touching the network.
   * A failed import is also forgotten on its own once `backoffMs` has passed,
   * so a view that mounts again later heals without a click.
   */
  reset(): void;
}

export interface RetryableLazyOptions {
  /** Delay before a mount after a failure asks the network again, by consecutive failures. */
  readonly backoffMs?: (consecutiveFailures: number) => number;
  /** Clock for the backoff; tests replace it. */
  readonly now?: () => number;
}

/** 1 s after the first failure, doubling to 30 s: a recovered connection heals, a dead one is not hammered. */
function defaultBackoffMs(consecutiveFailures: number): number {
  return Math.min(1_000 * 2 ** (consecutiveFailures - 1), 30_000);
}

interface LazyBinding<Props extends object> {
  /** The component once its chunk arrived, else `null`. */
  loaded(): ComponentType<Props> | null;
  /** A `React.lazy` view of the current attempt, which suspends until it settles. */
  lazyView(): ComponentType<Props>;
}

interface LazyHostProps<Props extends object> {
  readonly binding: LazyBinding<Props>;
  readonly componentProps: Props;
}

/**
 * Picks, once per mount, between the chunk's component and a suspending view.
 *
 * A `React.lazy` view always suspends on its first render, even when the chunk
 * is already in the module map, so a click on a button that was warmed by a
 * hover would still show the fallback, and React then holds the reveal back to
 * avoid a flash (up to 300 ms). A warmed chunk renders directly instead. The
 * choice is fixed for the life of the mount so the panel never remounts, and
 * loses its state, when the import settles under it.
 */
function LazyHost<Props extends object>({ binding, componentProps }: LazyHostProps<Props>) {
  const [View] = useState(() => binding.loaded() ?? binding.lazyView());
  return createElement(View, componentProps);
}

/**
 * `React.lazy` whose failure can be retried and whose import can be started
 * early.
 *
 * @example
 * const GitPanel = retryableLazy(() => import('../GitPanel').then((m) => ({ default: m.GitPanel })));
 * <Suspense fallback={<Spinner />}><GitPanel.Component chatId={id} /></Suspense>
 */
export function retryableLazy<Props extends object>(
  load: () => Promise<{ default: (props: Props) => ReactNode }>,
  { backoffMs = defaultBackoffMs, now = Date.now }: RetryableLazyOptions = {}
): RetryableLazy<Props> {
  // `lazy` wants a `ComponentType`; a function component taking `Props` is one.
  type Loaded = { default: ComponentType<Props> };
  /** One try at the import. `failedAt` is set when its promise rejects. */
  interface Attempt {
    view: ComponentType<Props>;
    pending: Promise<Loaded> | null;
    failedAt: number | null;
  }
  let loadedComponent: ComponentType<Props> | null = null;
  let consecutiveFailures = 0;

  // One shared promise per attempt, so `preload()` and the lazy component
  // never race two fetches of the same chunk.
  const begin = (attempt: Attempt) => {
    attempt.pending ??= (load() as Promise<Loaded>).then(
      (module) => {
        loadedComponent = module.default;
        consecutiveFailures = 0;
        return module;
      },
      (error: unknown): never => {
        // Mark the attempt that failed, not whichever is current by now: a
        // late rejection of an old attempt must not touch a newer one.
        attempt.failedAt = now();
        consecutiveFailures += 1;
        throw isChunkFetchFailure(error) ? new LazyChunkLoadError(error) : error;
      }
    );
    return attempt.pending;
  };

  const createAttempt = (): Attempt => {
    const attempt: Attempt = { view: undefined as never, pending: null, failedAt: null };
    attempt.view = lazy(() => begin(attempt));
    return attempt;
  };

  let current = createAttempt();

  /** The attempt a new mount should use: the current one, or a fresh one once its failure has aged out. */
  const attemptForMount = (): Attempt => {
    if (current.failedAt !== null && now() - current.failedAt >= backoffMs(consecutiveFailures)) {
      current = createAttempt();
    }
    return current;
  };

  const binding: LazyBinding<Props> = {
    loaded: () => loadedComponent,
    lazyView: () => attemptForMount().view,
  };

  return {
    Component: (props) => createElement(LazyHost<Props>, { binding, componentProps: props }),
    preload() {
      begin(attemptForMount()).catch(() => undefined);
    },
    reset() {
      if (current.failedAt !== null) current = createAttempt();
    },
  };
}
