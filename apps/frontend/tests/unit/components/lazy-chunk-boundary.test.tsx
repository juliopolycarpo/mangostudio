/**
 * The region that stands in for a panel whose chunk did not arrive. It must
 * say so in the person's language, offer a retry that reaches the network
 * again, and let any other error through to the route boundary.
 */

import { describe, expect, it } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { Component, type ReactNode, Suspense } from 'react';

import { LazyChunkBoundary } from '../../../src/components/layout/LazyChunkBoundary';
import { retryableLazy } from '../../../src/lib/retryable-lazy';
import { render, screen, waitFor } from '../../support/harness/render';

function Arrived() {
  return <p>panel body</p>;
}

/** An import that fails `failures` times, then resolves; counts every request. */
function fakeChunkLoader(failures: number) {
  const fake = {
    requests: 0,
    load: () => {
      fake.requests += 1;
      return fake.requests <= failures
        ? Promise.reject(new TypeError('Importing a module script failed.'))
        : Promise.resolve({ default: Arrived });
    },
  };
  return fake;
}

function Broken(): ReactNode {
  throw new Error('the panel itself is broken');
}

class RouteBoundaryFake extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }
  render() {
    return this.state.message === null ? (
      this.props.children
    ) : (
      <p data-testid="route-boundary">{this.state.message}</p>
    );
  }
}

describe('LazyChunkBoundary', () => {
  it('names the failure and recovers through Retry, which asks the network again', async () => {
    const user = userEvent.setup();
    const fake = fakeChunkLoader(1);
    const lazyBody = retryableLazy(fake.load);

    render(
      <LazyChunkBoundary onRetry={lazyBody.reset}>
        <Suspense fallback={<p>loading</p>}>
          <lazyBody.Component />
        </Suspense>
      </LazyChunkBoundary>
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.errors.lazyChunk.title);

    await user.click(screen.getByRole('button', { name: en.common.retry }));

    expect(await screen.findByText('panel body')).toBeInTheDocument();
    expect(fake.requests).toBe(2);
  });

  it('offers a page reload for the case where asking again cannot help', async () => {
    const lazyBody = retryableLazy(fakeChunkLoader(Number.POSITIVE_INFINITY).load);

    render(
      <LazyChunkBoundary onRetry={lazyBody.reset}>
        <Suspense fallback={null}>
          <lazyBody.Component />
        </Suspense>
      </LazyChunkBoundary>
    );

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: en.errors.lazyChunk.reload })).toBeInTheDocument();
  });

  it('rethrows an error that is not a chunk failure, so the route boundary still reports it', () => {
    // React logs the caught render error; keep the run's output readable.
    const originalError = console.error;
    console.error = () => undefined;
    try {
      render(
        <RouteBoundaryFake>
          <LazyChunkBoundary onRetry={() => undefined}>
            <Broken />
          </LazyChunkBoundary>
        </RouteBoundaryFake>
      );
    } finally {
      console.error = originalError;
    }

    expect(screen.getByTestId('route-boundary')).toHaveTextContent('the panel itself is broken');
    expect(screen.queryByTestId('lazy-chunk-failure')).not.toBeInTheDocument();
  });
});

describe('LazyChunkBoundary after a hub upgrade', () => {
  it('offers only Reload once the probe says this tab runs a stale build', async () => {
    const lazyBody = retryableLazy(fakeChunkLoader(Number.POSITIVE_INFINITY).load);

    render(
      <LazyChunkBoundary onRetry={lazyBody.reset} probeStaleBuild={() => Promise.resolve(true)}>
        <Suspense fallback={null}>
          <lazyBody.Component />
        </Suspense>
      </LazyChunkBoundary>
    );

    const alert = await screen.findByTestId('lazy-chunk-failure');
    await waitFor(() => expect(alert).toHaveTextContent(en.errors.lazyChunk.staleTitle));
    expect(screen.queryByRole('button', { name: en.common.retry })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.errors.lazyChunk.reload })).toBeInTheDocument();
  });

  it('keeps Retry while the probe cannot say the build is stale', async () => {
    const lazyBody = retryableLazy(fakeChunkLoader(Number.POSITIVE_INFINITY).load);

    render(
      <LazyChunkBoundary onRetry={lazyBody.reset} probeStaleBuild={() => Promise.resolve(false)}>
        <Suspense fallback={null}>
          <lazyBody.Component />
        </Suspense>
      </LazyChunkBoundary>
    );

    await screen.findByTestId('lazy-chunk-failure');
    expect(screen.getByRole('button', { name: en.common.retry })).toBeInTheDocument();
    expect(screen.getByTestId('lazy-chunk-failure')).toHaveTextContent(en.errors.lazyChunk.title);
  });
});

describe('LazyChunkBoundary with a graceful form', () => {
  it('draws renderFailure instead of the panel and reports the failure once', async () => {
    const fake = fakeChunkLoader(Number.POSITIVE_INFINITY);
    const lazyBody = retryableLazy(fake.load);
    const failures: string[] = [];

    render(
      <LazyChunkBoundary
        onRetry={lazyBody.reset}
        onFailure={() => failures.push('failed')}
        renderFailure={() => <p>plain text stays</p>}
      >
        <Suspense fallback={null}>
          <lazyBody.Component />
        </Suspense>
      </LazyChunkBoundary>
    );

    expect(await screen.findByText('plain text stays')).toBeInTheDocument();
    expect(screen.queryByTestId('lazy-chunk-failure')).not.toBeInTheDocument();
    expect(failures).toEqual(['failed']);
  });
});
