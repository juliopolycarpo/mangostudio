/**
 * The palette opens before its results chunk has arrived. The eager frame owns
 * the input in that window: focus is in the palette, typed text survives into
 * the results as their query, Enter runs nothing, and Escape closes and gives
 * focus back to the opener.
 *
 * The chunk is a named fake whose promise the test resolves by hand, so each
 * case states exactly which side of the arrival it is asserting.
 */

import { describe, expect, it, jest } from 'bun:test';

import { fireEvent } from '@testing-library/react';
import { useState } from 'react';

import { createLazyOverlay } from '../../../../src/components/layout/LazyOverlay';
import { PaletteResults } from '../../../../src/features/command-palette/CommandPalette';
import type { CommandItem } from '../../../../src/features/command-palette/lib/command-item';
import {
  PaletteFrame,
  type PaletteFrameState,
} from '../../../../src/features/command-palette/PaletteFrame';
import { act, render, screen } from '../../../support/harness/render';

const runNewChat = jest.fn();
const runGallery = jest.fn();

const paletteItems: readonly CommandItem[] = [
  { id: 'action:new-chat', section: 'actions', label: 'New chat', run: runNewChat },
  { id: 'navigate:/gallery', section: 'navigate', label: 'Gallery', run: runGallery },
];

interface ResultsChunkProps extends PaletteFrameState {
  readonly onClose: () => void;
}

function RegistryResults({ onClose: _onClose, ...frame }: ResultsChunkProps) {
  return <PaletteResults {...frame} items={paletteItems} />;
}

/** A chunk that stays in flight until `arrive()` is called. */
function fakeLateResultsChunk() {
  let arrive: () => void = () => {};
  const fake = {
    load: () =>
      new Promise<{ default: typeof RegistryResults }>((resolve) => {
        arrive = () => resolve({ default: RegistryResults });
      }),
    arrive: () => arrive(),
  };
  return fake;
}

/** A composer that a stray keystroke or Enter would reach, and an opener button. */
function paletteOwner(overlay: ReturnType<typeof createLazyOverlay<ResultsChunkProps>>) {
  const composerSends = jest.fn();
  function Owner() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          open palette
        </button>
        <textarea
          aria-label="composer"
          onKeyDown={(event) => {
            if (event.key === 'Enter') composerSends();
          }}
        />
        {open ? (
          <PaletteFrame onClose={() => setOpen(false)}>
            {(frame) => (
              <overlay.Overlay
                {...frame}
                onClose={() => setOpen(false)}
                onLoadFailed={() => setOpen(false)}
              />
            )}
          </PaletteFrame>
        ) : null}
      </>
    );
  }
  return { Owner, composerSends };
}

function openPaletteFromButton() {
  const opener = screen.getByRole('button', { name: 'open palette' });
  opener.focus();
  act(() => opener.click());
  return opener;
}

describe('palette while its results chunk is still loading', () => {
  it('takes focus on open, before the chunk has arrived', () => {
    const chunk = fakeLateResultsChunk();
    const { Owner } = paletteOwner(createLazyOverlay<ResultsChunkProps>(chunk.load));
    render(<Owner />);

    openPaletteFromButton();

    expect(document.activeElement, 'focused element before the chunk arrives').toBe(
      screen.getByRole('combobox')
    );
  });

  it('keeps typed text and hands it to the results as their query, caret at the end', async () => {
    const chunk = fakeLateResultsChunk();
    const { Owner } = paletteOwner(createLazyOverlay<ResultsChunkProps>(chunk.load));
    render(<Owner />);
    openPaletteFromButton();

    const input = screen.getByRole<HTMLInputElement>('combobox');
    fireEvent.change(input, { target: { value: 'gal' } });
    expect(screen.queryByRole('option')).not.toBeInTheDocument();

    act(() => chunk.arrive());

    // The same element survives the arrival, so an IME composition in flight is
    // not interrupted, and the results already rank by what was typed.
    expect(await screen.findByRole('option', { name: /Gallery/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBe(input);
    expect(input.value, 'input value after the chunk arrives').toBe('gal');
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('option', { name: /New chat/ })).not.toBeInTheDocument();
  });

  it('swallows Enter until results exist, so nothing runs and the composer is not sent', async () => {
    const chunk = fakeLateResultsChunk();
    const { Owner, composerSends } = paletteOwner(createLazyOverlay<ResultsChunkProps>(chunk.load));
    render(<Owner />);
    openPaletteFromButton();

    const input = screen.getByRole('combobox');
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter' });

    expect(notPrevented, 'Enter left to its default action').toBe(false);
    expect(runNewChat).not.toHaveBeenCalled();
    expect(composerSends).not.toHaveBeenCalled();

    act(() => chunk.arrive());
    await screen.findByRole('option', { name: /New chat/ });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    expect(runNewChat, 'runs of the best match once results exist').toHaveBeenCalledTimes(1);
  });

  it('closes on Escape during the load and returns focus to the opener', () => {
    const chunk = fakeLateResultsChunk();
    const { Owner } = paletteOwner(createLazyOverlay<ResultsChunkProps>(chunk.load));
    render(<Owner />);
    const opener = openPaletteFromButton();

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(document.activeElement, 'focused element after Escape').toBe(opener);
  });
});
