/**
 * The studio landing: two ways in, and the newest few images.
 *
 * The gallery query is faked rather than fetched — what this covers is the
 * landing's own wiring (the image toggle it presses, the strip it caps) and not
 * a second copy of the gallery's pagination tests.
 */

import { describe, expect, it, jest, mock } from 'bun:test';
import type { GalleryItem } from '@mangostudio/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../../../src/lib/app-context';
import { render } from '../../support/harness/render';
import { routerWithLinkStub } from '../../support/mocks/router';

const navigateMock = jest.fn();
const galleryState = { items: [] as GalleryItem[], status: 'success' as 'pending' | 'success' };

// The module under test is imported afterwards so it binds to the mocks rather
// than to the originals: `mock.module` is not hoisted and static imports are.
//
// `mock.module` mutates a module graph that `bun test` shares across files and
// survives `mock.restore()`, so this lane runs under `--isolate`. Without it,
// every later file in the run would get this `Link` too.
mock.module(
  '@tanstack/react-router',
  await routerWithLinkStub({ useNavigate: () => navigateMock })
);
mock.module('../../../src/features/gallery/queries', () => ({
  useGalleryQuery: () => ({
    data: { pages: [{ items: galleryState.items, nextCursor: null }], pageParams: [null] },
    status: galleryState.status,
  }),
}));

const { StudioPage } = await import('../../../src/features/studio/StudioPage');

const setImageToolIntent = jest.fn();

function renderStudio() {
  return render(
    <AppContext value={{ setImageToolIntent } as never}>
      <StudioPage />
    </AppContext>
  );
}

function imageAt(index: number): GalleryItem {
  return {
    id: `img-${index}`,
    chatId: 'chat-1',
    messageId: `message-${index}`,
    prompt: `Generated image ${index}`,
    imageUrl: `https://example.com/generated/${index}.png`,
    createdAt: index,
  };
}

describe('Studio landing', () => {
  it('renders the studio title', () => {
    renderStudio();

    expect(screen.getByRole('heading', { name: 'Studio' })).toBeInTheDocument();
  });

  it('hands the composer over with the image tool already on', async () => {
    const user = userEvent.setup();
    setImageToolIntent.mockReset();
    navigateMock.mockReset();
    renderStudio();

    await user.click(screen.getByRole('button', { name: /start in chat/i }));

    expect(setImageToolIntent).toHaveBeenCalledWith(true);
    expect(navigateMock).toHaveBeenCalledWith({ to: '/' });
  });

  it('offers the gallery as the other way in', () => {
    renderStudio();

    expect(screen.getByRole('link', { name: /open gallery/i })).toHaveAttribute('href', '/gallery');
  });

  it('says so plainly when nothing has been generated', () => {
    galleryState.items = [];
    renderStudio();

    expect(screen.getByText(/nothing generated yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view all/i })).not.toBeInTheDocument();
  });

  it('shows the newest images only, not the whole first page', () => {
    galleryState.items = [0, 1, 2, 3, 4, 5].map(imageAt);
    renderStudio();

    expect(screen.getAllByRole('img')).toHaveLength(4);
    expect(screen.getByAltText('Generated image 0')).toBeInTheDocument();
    expect(screen.queryByAltText('Generated image 4')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view all/i })).toHaveAttribute('href', '/gallery');
  });
});
