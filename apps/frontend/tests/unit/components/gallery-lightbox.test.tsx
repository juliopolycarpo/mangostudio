/**
 * The lightbox's keyboard contract.
 *
 * A full-screen overlay that cannot be dismissed from the keyboard, and that
 * Tab walks straight out of into the page behind it, is worth pinning here
 * rather than leaving to whichever surface happens to open it — and there are
 * two of those now, the gallery grid and the studio's recent strip.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { GalleryItem } from '@mangostudio/shared/types';
import { GalleryLightbox } from '@/features/gallery/components/GalleryLightbox';
import { fireEvent, render, screen } from '../../support/harness/render';

const ITEM: GalleryItem = {
  id: 'img-42',
  chatId: 'chat-1',
  messageId: 'message-1',
  prompt: 'Aurora over a quiet mountain lake',
  imageUrl: 'https://example.com/generated/aurora.png',
  createdAt: 1,
};

describe('GalleryLightbox', () => {
  it('announces itself as a modal dialog rather than an unnamed overlay', () => {
    render(<GalleryLightbox item={ITEM} onClose={jest.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName();
  });

  it('closes on Escape', () => {
    const onClose = jest.fn();
    render(<GalleryLightbox item={ITEM} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The close control lives in the caption card with the download link, not
  // pinned to the window's corner, where it landed on the header's account
  // button. A press on it is one close, not one for the button and one for the
  // overlay behind it.
  it('closes once from a button inside the panel', () => {
    const onClose = jest.fn();
    render(<GalleryLightbox item={ITEM} onClose={onClose} />);

    const close = screen.getByRole('button', { name: 'Close image' });
    expect(close.closest('[role="dialog"] > div')).not.toBeNull();
    fireEvent.click(close);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('takes focus, so the keyboard is inside the overlay and not behind it', () => {
    render(<GalleryLightbox item={ITEM} onClose={jest.fn()} />);

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('cycles Tab within its own controls instead of leaving for the page below', () => {
    render(<GalleryLightbox item={ITEM} onClose={jest.fn()} />);

    // From the dialog itself, Shift+Tab wraps to the last control it owns —
    // the download link — rather than reaching whatever precedes the overlay.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole('link'));
  });

  // A picture is not themed, so neither is the ground it is viewed on nor the
  // text laid on that ground: `canvas` made the viewer a near-white sheet in the
  // light theme, and `surface` / `fg` made the caption a white card.
  describe('media veil', () => {
    it('sits on the theme-independent media veil, not on the theme’s canvas', () => {
      render(<GalleryLightbox item={ITEM} onClose={jest.fn()} />);

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveClass('bg-scrim-media');
      expect(dialog).not.toHaveClass('bg-canvas');
    });

    it('reads the prompt in on-scrim-media text', () => {
      render(<GalleryLightbox item={ITEM} onClose={jest.fn()} />);

      const prompt = screen.getByText(ITEM.prompt);
      expect(prompt).toHaveClass('text-on-scrim-media');
      expect(prompt).not.toHaveClass('text-fg');
    });

    // The global ring is the theme's `focus`: dark brown in the light theme, on
    // a dark veil.
    it('draws its controls’ focus ring in on-scrim-media', () => {
      render(<GalleryLightbox item={ITEM} onClose={jest.fn()} />);

      expect(screen.getByRole('button', { name: 'Close image' })).toHaveClass(
        'focus-visible:outline-on-scrim-media'
      );
      expect(screen.getByRole('link')).toHaveClass('focus-visible:outline-on-scrim-media');
    });
  });

  it('renders nothing at all when no image is selected', () => {
    render(<GalleryLightbox item={null} onClose={jest.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
