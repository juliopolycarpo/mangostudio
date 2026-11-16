/**
 * `retryableLazy` is `React.lazy` that can be asked again after a failed
 * import and warmed before it renders. The cases pin the two things plain
 * `lazy` cannot do, and that a failure is tagged so a boundary can tell a
 * missing chunk from a bug in the panel.
 */

import { describe, expect, it } from 'bun:test';

import { render, screen } from '@testing-library/react';
import { Component, type ReactNode, Suspense } from 'react';

import { LazyChunkLoadError, retryableLazy } from '../../../src/lib/retryable-lazy';

function Hello({ name }: { name: string }) {
  return <p>hello {name}</p>;
}

/**
 * Named fake for a dynamic import: counts how often the "network" was asked,
 * and fails the first `failures` times the way a browser does.
 */
function fakeChunkLoader(failures: number) {
  const fake = {
    requests: 0,
    load: () => {
      fake.requests += 1;
      return fake.requests <= failures
        ? Promise.reject(
            new TypeError('Failed to fetch dynamically imported module: /assets/chunk-fake.js')
          )
        : Promise.resolve({ default: Hello });
    },
  };
  return fake;
}

/** Records what reached it, instead of rendering a fallback. */
class ErrorRecorder extends Component<
  { children: ReactNode; seen: unknown[] },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.seen.push(error);
  }
  render() {
    return this.state.failed ? <p>boundary caught</p> : this.props.children;
  }
}

describe('retryableLazy', () => {
  it('renders the component once its import settles', async () => {
    const fake = fakeChunkLoader(0);
    const lazyHello = retryableLazy(fake.load);

    render(
      <Suspense fallback={<p>loading</p>}>
        <lazyHello.Component name="rail" />
      </Suspense>
    );

    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(await screen.findByText('hello rail')).toBeInTheDocument();
    expect(fake.requests).toBe(1);
  });

  it('shares one import between preload() and the render that follows', async () => {
    const fake = fakeChunkLoader(0);
    const lazyHello = retryableLazy(fake.load);

    lazyHello.preload();
    lazyHello.preload();
    render(
      <Suspense fallback={null}>
        <lazyHello.Component name="warm" />
      </Suspense>
    );

    expect(await screen.findByText('hello warm')).toBeInTheDocument();
    expect(fake.requests).toBe(1);
  });

  it('renders a warmed chunk on the first commit, without flashing the fallback', async () => {
    const fake = fakeChunkLoader(0);
    const lazyHello = retryableLazy(fake.load);

    lazyHello.preload();
    await Bun.sleep(0);
    render(
      <Suspense fallback={<p>loading</p>}>
        <lazyHello.Component name="warmed" />
      </Suspense>
    );

    // `getBy`, not `findBy`: nothing may be pending after the first commit.
    expect(screen.getByText('hello warmed')).toBeInTheDocument();
    expect(screen.queryByText('loading')).not.toBeInTheDocument();
  });

  it('tags a failed import as a LazyChunkLoadError that keeps the browser error as its cause', async () => {
    const fake = fakeChunkLoader(1);
    const lazyHello = retryableLazy(fake.load);
    const seen: unknown[] = [];

    render(
      <ErrorRecorder seen={seen}>
        <Suspense fallback={null}>
          <lazyHello.Component name="x" />
        </Suspense>
      </ErrorRecorder>
    );

    expect(await screen.findByText('boundary caught')).toBeInTheDocument();
    const [error] = seen;
    expect(error).toBeInstanceOf(LazyChunkLoadError);
    expect((error as LazyChunkLoadError).cause).toBeInstanceOf(TypeError);
    expect((error as LazyChunkLoadError).message).toContain('Failed to fetch dynamically imported');
  });

  it('asks the network again after reset(), where plain React.lazy would replay the failure', async () => {
    const fake = fakeChunkLoader(1);
    const lazyHello = retryableLazy(fake.load);
    const seen: unknown[] = [];

    const first = render(
      <ErrorRecorder seen={seen}>
        <Suspense fallback={null}>
          <lazyHello.Component name="again" />
        </Suspense>
      </ErrorRecorder>
    );
    await screen.findByText('boundary caught');
    first.unmount();

    lazyHello.reset();
    render(
      <Suspense fallback={null}>
        <lazyHello.Component name="again" />
      </Suspense>
    );

    expect(await screen.findByText('hello again')).toBeInTheDocument();
    expect(fake.requests).toBe(2);
  });

  it('leaves a failed preload for the render to report, without an unhandled rejection', async () => {
    const fake = fakeChunkLoader(1);
    const lazyHello = retryableLazy(fake.load);

    lazyHello.preload();
    await Bun.sleep(0);
    lazyHello.preload();
    await Bun.sleep(0);

    // The failed attempt is forgotten, so the second preload fetched again and won.
    expect(fake.requests).toBe(2);
  });
});
