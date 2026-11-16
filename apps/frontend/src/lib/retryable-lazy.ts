import { type ComponentType, createElement, lazy, type ReactNode, useState } from 'react';

/**
 * What a `retryableLazy` import throws when its chunk cannot be fetched or
 * evaluated: offline, a 404 for a hashed name the hub no longer has after an
 * upgrade under an open tab, or a script that threw while it ran.
 *
 * Its own class so a boundary can treat this failure, and only this one, as
 * "the code did not arrive". Browsers word the underlying `TypeError`
 * differently ("Failed to fetch dynamically imported module", "error loading
 * dynamically imported module", "Importing a module script failed"), so
 * matching on the message would miss one of them.
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
   * Forgets a failed import so the next render fetches again. `React.lazy` keeps
   * a rejected promise for good, so without this a retry would re-throw the
   * first failure without touching the network.
   */
  reset(): void;
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
  load: () => Promise<{ default: (props: Props) => ReactNode }>
): RetryableLazy<Props> {
  // `lazy` wants a `ComponentType`; a function component taking `Props` is one.
  type Loaded = { default: ComponentType<Props> };
  let pending: Promise<Loaded> | null = null;
  let loadedComponent: ComponentType<Props> | null = null;

  // One shared promise per attempt, so `preload()` and the lazy component
  // never race two fetches of the same chunk.
  const start = () => {
    pending ??= (load() as Promise<Loaded>).then(
      (module) => {
        loadedComponent = module.default;
        return module;
      },
      (error: unknown): never => {
        pending = null;
        throw new LazyChunkLoadError(error);
      }
    );
    return pending;
  };

  let current = lazy(start);
  const binding: LazyBinding<Props> = {
    loaded: () => loadedComponent,
    lazyView: () => current,
  };

  return {
    Component: (props) => createElement(LazyHost<Props>, { binding, componentProps: props }),
    preload() {
      start().catch(() => undefined);
    },
    reset() {
      pending = null;
      loadedComponent = null;
      current = lazy(start);
    },
  };
}
