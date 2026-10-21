/**
 * The image is the control that opens it, and the caption bar over its foot
 * carries the prompt and a download link. What is worth pinning is the part that
 * breaks without anyone noticing in a unit lane:
 *
 * - the bar fades in on hover *and* focus, because its link is tabbable;
 * - the bar never takes pointer events itself, or it would swallow taps on the
 *   foot of the image while invisible and clicks on its own text while shown;
 * - nothing clips the focus ring, which sits outside the control it belongs to.
 *
 * Asserted on the class list rather than through `getComputedStyle`: the unit
 * lane renders without the Tailwind stylesheet, so computed opacity is `1` here
 * whatever the markup says, and a test reading it would pass on the broken
 * version too.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { GalleryItem } from '@mangostudio/shared/types';
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

/** The caption bar holding the prompt and the download link — the element that fades in. */
function captionOf(container: HTMLElement): HTMLElement {
  const caption = container.querySelector<HTMLElement>('.opacity-0');
  if (!caption) {
    throw new Error('The tile no longer has a hidden caption bar to reveal.');
  }
  return caption;
}

describe('GalleryTile', () => {
  it('opens the image when the image itself is pressed', async () => {
    const onView = jest.fn();
    render(<GalleryTile item={TEST_ITEM} onView={onView} />);

    await userEvent.setup().click(screen.getByRole('button', { name: /view image/i }));

    expect(onView).toHaveBeenCalledWith(TEST_ITEM);
  });

  it('names the control by what it opens and says that it opens a dialog', () => {
    render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);

    const button = screen.getByRole('button', {
      name: 'View image: Aurora over a quiet mountain lake',
    });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(button).toContainElement(screen.getByAltText(TEST_ITEM.prompt));
  });

  it('reveals its caption on focus, not on hover alone', () => {
    const { container } = render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);

    expect(captionOf(container)).toHaveClass('group-focus-within:opacity-100');
  });

  it('still reveals it on hover', () => {
    const { container } = render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);

    expect(captionOf(container)).toHaveClass('group-hover:opacity-100');
  });

  // Nested interactive elements are invalid, and the reveal is keyed off the
  // wrapper, so the link has to sit in the bar and the bar beside the button.
  it('keeps the download link in the caption, outside the button', () => {
    const { container } = render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);
    const caption = captionOf(container);
    const link = screen.getByRole('link', { name: /download image/i });

    expect(caption).toContainElement(link);
    expect(screen.getByRole('button', { name: /view image/i })).not.toContainElement(link);
  });

  it('lets a press on the bar through to the image, and gives events only to the shown link', () => {
    const { container } = render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);

    // The bar never takes events, so a tap on the invisible foot of the tile
    // opens the image and so does a click on the caption's own text.
    expect(captionOf(container)).toHaveClass('pointer-events-none');
    // The link takes them only while the bar is shown, never while it is faded out.
    const link = screen.getByRole('link', { name: /download image/i });
    expect(link).toHaveClass('pointer-events-none');
    expect(link).toHaveClass('group-hover:pointer-events-auto');
    expect(link).toHaveClass('group-focus-within:pointer-events-auto');
  });

  // The global ring is drawn 2px outside the control. A wrapper that clips would
  // cut it off, so the clipping and the rounding belong to the button.
  it('clips the image on the button, not on the wrapper that carries the focus ring', () => {
    const { container } = render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);

    const button = screen.getByRole('button', { name: /view image/i });
    expect(button).toHaveClass('overflow-hidden', 'rounded-md');
    expect(container.firstElementChild).not.toHaveClass('overflow-hidden');
    expect(container.firstElementChild).toHaveClass('group', 'relative');
  });

  // Icon-only, so without a label the link announces as its URL or as nothing.
  it('names the download link for a screen reader', () => {
    render(<GalleryTile item={TEST_ITEM} onView={jest.fn()} />);

    expect(screen.getByRole('link', { name: /download image/i })).toHaveAttribute(
      'download',
      'mangostudio-art-img-42.png'
    );
  });

  it('is just the image when compact, with the prompt and download left to the lightbox', async () => {
    const onView = jest.fn();
    const { container } = render(<GalleryTile item={TEST_ITEM} onView={onView} compact />);

    expect(container.querySelector('.opacity-0')).toBeNull();
    expect(screen.queryByRole('link', { name: /download image/i })).not.toBeInTheDocument();
    expect(screen.queryByText(TEST_ITEM.prompt)).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: /view image/i }));
    expect(onView).toHaveBeenCalledWith(TEST_ITEM);
  });
});
