/**
 * The region that stands in for a panel whose chunk did not arrive. It must
 * say so in the person's language, offer a retry that reaches the network
 * again, and let any other error through to the route boundary.
 */

import { describe, expect, it } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { Component, type ReactNode, Suspense, useRef } from 'react';

import { LazyChunkBoundary } from '../../../src/components/layout/LazyChunkBoundary';
import { StaleBuildNotice } from '../../../src/components/layout/StaleBuildNotice';
import { retryableLazy } from '../../../src/lib/retryable-lazy';
import { createStaleBuildMonitor, type StaleBuildMonitor } from '../../../src/lib/stale-build';
import { act, render, screen, waitFor } from '../../support/harness/render';

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

  it('moves focus to the panel region when Retry unmounts under the keyboard', async () => {
    const user = userEvent.setup();
    const lazyBody = retryableLazy(fakeChunkLoader(1).load);

    render(
      <LazyChunkBoundary onRetry={lazyBody.reset}>
        <Suspense fallback={<p>loading</p>}>
          <lazyBody.Component />
        </Suspense>
      </LazyChunkBoundary>
    );
    const retry = await screen.findByRole('button', { name: en.common.retry });
    retry.focus();
    await user.keyboard('{Enter}');
    await screen.findByText('panel body');

    expect(
      document.activeElement,
      `expected focus on the lazy-chunk region after Retry | received: ${
        document.activeElement?.tagName ?? 'nothing'
      }`
    ).toBe(screen.getByTestId('lazy-chunk-region'));
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

/** A tab that loaded `loaded`, with the hub's shell naming `shellEntry`; counts every shell fetch. */
function fakeHub(loaded: string, shellEntry: string) {
  const hub = {
    shellFetches: 0,
    monitor: createStaleBuildMonitor({
      loadedEntryScript: () => loaded,
      fetchShell: () => {
        hub.shellFetches += 1;
        return Promise.resolve(`<script type="module" src="${shellEntry}"></script>`);
      },
    }),
  };
  return hub;
}

const staleHub = () => fakeHub('/assets/main-aaaa1111.js', '/assets/main-bbbb2222.js');
const currentHub = () => fakeHub('/assets/main-aaaa1111.js', '/assets/main-aaaa1111.js');

function FailingSurface({ monitor, name }: { monitor: StaleBuildMonitor; name: string }) {
  const lazyBody = useRef(retryableLazy(fakeChunkLoader(Number.POSITIVE_INFINITY).load)).current;
  return (
    <section aria-label={name}>
      <LazyChunkBoundary onRetry={lazyBody.reset} monitor={monitor}>
        <Suspense fallback={null}>
          <lazyBody.Component />
        </Suspense>
      </LazyChunkBoundary>
    </section>
  );
}

describe('LazyChunkBoundary after a hub upgrade', () => {
  it('drops Retry once the probe says this tab runs a stale build, and the notice carries the one Reload', async () => {
    const hub = staleHub();

    render(
      <>
        <FailingSurface monitor={hub.monitor} name="terminal" />
        <StaleBuildNotice monitor={hub.monitor} />
      </>
    );

    const alert = await screen.findByTestId('lazy-chunk-failure');
    await waitFor(() => expect(alert).toHaveTextContent(en.errors.lazyChunk.staleTitle));
    expect(screen.queryByRole('button', { name: en.common.retry })).not.toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: en.errors.lazyChunk.reload }),
      'expected exactly one Reload on the page, in the notice'
    ).toHaveLength(1);
    expect(screen.getByTestId('stale-build-notice')).toContainElement(
      screen.getByRole('button', { name: en.errors.lazyChunk.reload })
    );
  });

  it('shows one Reload and fetches index.html once for two surfaces failing together', async () => {
    const hub = staleHub();

    render(
      <>
        <FailingSurface monitor={hub.monitor} name="terminal" />
        <FailingSurface monitor={hub.monitor} name="diff" />
        <StaleBuildNotice monitor={hub.monitor} />
      </>
    );

    await waitFor(() => expect(screen.getAllByTestId('lazy-chunk-failure')).toHaveLength(2));
    await screen.findByTestId('stale-build-notice');
    expect(screen.getAllByRole('button', { name: en.errors.lazyChunk.reload })).toHaveLength(1);
    expect(hub.shellFetches, 'index.html fetches for two failing surfaces').toBe(1);
  });

  it('keeps Retry and the local Reload while the build is not stale', async () => {
    const hub = currentHub();

    render(
      <>
        <FailingSurface monitor={hub.monitor} name="terminal" />
        <StaleBuildNotice monitor={hub.monitor} />
      </>
    );

    await screen.findByTestId('lazy-chunk-failure');
    await waitFor(() => expect(hub.shellFetches).toBe(1));
    expect(screen.getByRole('button', { name: en.common.retry })).toBeInTheDocument();
    expect(screen.getByTestId('lazy-chunk-failure')).toHaveTextContent(en.errors.lazyChunk.title);
    expect(screen.queryByTestId('stale-build-notice')).not.toBeInTheDocument();
  });

  it('moves focus to the notice Reload when the probe removes the Retry button under the keyboard', async () => {
    const hub = staleHub();
    let resolveShell: (shell: string) => void = () => undefined;
    const slowMonitor = createStaleBuildMonitor({
      loadedEntryScript: () => '/assets/main-aaaa1111.js',
      fetchShell: () =>
        new Promise<string>((resolve) => {
          resolveShell = resolve;
        }),
    });

    render(
      <>
        <FailingSurface monitor={slowMonitor} name="terminal" />
        <StaleBuildNotice monitor={slowMonitor} />
      </>
    );
    const retry = await screen.findByRole('button', { name: en.common.retry });
    retry.focus();
    expect(retry).toHaveFocus();

    await act(async () => {
      resolveShell('<script type="module" src="/assets/main-bbbb2222.js"></script>');
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: en.errors.lazyChunk.reload })).toHaveFocus()
    );
    expect(hub.shellFetches).toBe(0);
  });
});

describe('LazyChunkBoundary with a graceful form', () => {
  it('draws renderFailure instead of the panel, and still reports a stale build to the page', async () => {
    const hub = staleHub();
    const lazyBody = retryableLazy(fakeChunkLoader(Number.POSITIVE_INFINITY).load);

    render(
      <>
        <LazyChunkBoundary
          onRetry={lazyBody.reset}
          monitor={hub.monitor}
          renderFailure={() => <p>plain text stays</p>}
        >
          <Suspense fallback={null}>
            <lazyBody.Component />
          </Suspense>
        </LazyChunkBoundary>
        <StaleBuildNotice monitor={hub.monitor} />
      </>
    );

    expect(await screen.findByText('plain text stays')).toBeInTheDocument();
    expect(screen.queryByTestId('lazy-chunk-failure')).not.toBeInTheDocument();
    expect(await screen.findByTestId('stale-build-notice')).toBeInTheDocument();
  });
});
