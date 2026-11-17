/**
 * `createLazyOverlay` keeps a dialog or popover body out of the entry chunk. The
 * cases pin what a person sees: the overlay appears once its chunk arrives,
 * a chunk that cannot be fetched is announced and closes the overlay (not a
 * dead click), and the next attempt asks the network again.
 */

import { describe, expect, it } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import { useState } from 'react';

import { createLazyOverlay } from '../../../src/components/layout/LazyOverlay';
import { act, render, screen, waitFor } from '../../support/harness/render';

interface GreetingProps {
  readonly name: string;
}

function Greeting({ name }: GreetingProps) {
  return <p data-testid="greeting">hello {name}</p>;
}

/**
 * Named fake for a dynamic import: counts how often the "network" was asked and
 * fails the first `failures` asks the way a browser does for a missing chunk.
 */
function fakeOverlayChunk(failures: number) {
  const fake = {
    requests: 0,
    load: () => {
      fake.requests += 1;
      return fake.requests <= failures
        ? Promise.reject(
            new TypeError('Failed to fetch dynamically imported module: /assets/chunk-fake.js')
          )
        : Promise.resolve({ default: Greeting });
    },
  };
  return fake;
}

/** Owner that opens the overlay on a click and closes it when the chunk fails. */
function overlayOwner(overlay: ReturnType<typeof createLazyOverlay<GreetingProps>>) {
  return function Owner() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
        {open ? <overlay.Overlay name="Ada" onLoadFailed={() => setOpen(false)} /> : null}
      </>
    );
  };
}

describe('createLazyOverlay', () => {
  it('renders the overlay once its chunk arrives', async () => {
    const chunk = fakeOverlayChunk(0);
    const Owner = overlayOwner(createLazyOverlay<GreetingProps>(chunk.load));
    render(<Owner />);

    act(() => screen.getByRole('button', { name: 'open' }).click());

    expect(await screen.findByTestId('greeting')).toHaveTextContent('hello Ada');
    expect(chunk.requests, 'chunk requests').toBe(1);
  });

  it('does not touch the network until the overlay is opened or preloaded', async () => {
    const chunk = fakeOverlayChunk(0);
    const overlay = createLazyOverlay<GreetingProps>(chunk.load);
    const Owner = overlayOwner(overlay);
    render(<Owner />);
    expect(chunk.requests, 'requests before any interaction').toBe(0);

    overlay.preload();
    overlay.preload();
    await waitFor(() => expect(chunk.requests).toBe(1));
  });

  it('tells the person and closes when the chunk cannot be fetched, then asks again on the next open', async () => {
    const chunk = fakeOverlayChunk(1);
    const Owner = overlayOwner(createLazyOverlay<GreetingProps>(chunk.load));
    render(<Owner />);

    act(() => screen.getByRole('button', { name: 'open' }).click());

    expect(await screen.findByText(en.errors.lazyChunk.title)).toBeInTheDocument();
    expect(screen.queryByTestId('greeting')).not.toBeInTheDocument();
    expect(chunk.requests, 'requests after the failure').toBe(1);

    act(() => screen.getByRole('button', { name: 'open' }).click());

    expect(await screen.findByTestId('greeting')).toHaveTextContent('hello Ada');
    expect(chunk.requests, 'requests after the second open').toBe(2);
  });
});
