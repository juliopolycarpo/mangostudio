/**
 * The tile's two actions sit under an overlay that is transparent until the
 * pointer arrives, which is the part worth pinning: both are tabbable, so a
 * reveal keyed to hover alone leaves a keyboard user with a focus ring on
 * something they cannot see.
 *
 * Asserted on the class list rather than through `getComputedStyle`: the unit
 * lane renders without the Tailwind stylesheet, so computed opacity is `1` here
 * whatever the markup says, and a test reading it would pass on the broken
 * version too.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { GalleryItem } from '@mangostudio/shared';
import userEvent from '@testing-library/user-event';
import { GalleryTile } from '../../../src/features/gallery/components/GalleryTile';
import { render, screen } from '../../support/harness/render';

const TEST_ITEM: GalleryItem = {
  id: 'img-42',
  chatId: 'chat-1',
  messageId: 'message-1',
  prompt: 'Aurora over a quiet mountain lake',
  imageUrl: 'https://example.com/generated/aurora.png',
  createdAt: 1,
};

/** The overlay holding the prompt and the actions — the element that fades in. */
function overlayOf(container: HTMLElement): HTMLElement {
  const overlay = container.querySelector<HTMLElement>('.opacity-0');
  if (!overlay) {
    throw new Error('The tile no longer has a hidden overlay to reveal.');
  }
  return overlay;
}

describe('GalleryTile', () => {
  it('reveals its actions on focus, not on hover alone', () => {
    const { container } = render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);

    expect(overlayOf(container)).toHaveClass('group-focus-within:opacity-100');
  });

  it('still reveals them on hover', () => {
    const { container } = render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);

    expect(overlayOf(container)).toHaveClass('group-hover:opacity-100');
  });

  // The reveal is keyed off the wrapper, so the controls have to be inside it
  // for `focus-within` to fire at all.
  it('keeps both controls inside the element the reveal is keyed to', () => {
    const { container } = render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);
    const overlay = overlayOf(container);

    expect(overlay).toContainElement(screen.getByRole('button', { name: /view/i }));
    expect(overlay).toContainElement(screen.getByRole('link', { name: /download image/i }));
  });

  // Icon-only, so without a label the link announces as its URL or as nothing.
  it('names the download link for a screen reader', () => {
    render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);

    expect(screen.getByRole('link', { name: /download image/i })).toHaveAttribute(
      'download',
      'mangostudio-art-img-42.png'
    );
  });

  it('opens the image through the callback it is given', async () => {
    const onView = jest.fn();
    render(<GalleryTile item={TEST_ITEM} onView={onView} />);

    await userEvent.setup().click(screen.getByRole('button', { name: /view/i }));

    expect(onView).toHaveBeenCalledWith(TEST_ITEM);
  });
});
