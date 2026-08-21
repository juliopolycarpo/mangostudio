import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { GalleryItem } from '@mangostudio/shared';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../support/harness/render';

const { fetchNextPageMock, galleryQueryState } = {
  fetchNextPageMock: jest.fn(),
  galleryQueryState: {
    current: {
      data: undefined as
        | {
            pages: Array<{ items: GalleryItem[]; nextCursor: string | null }>;
            pageParams: Array<string | null>;
          }
        | undefined,
      hasNextPage: false,
      isFetchingNextPage: false,
      status: 'pending' as 'pending' | 'success',
    },
  },
};

mock.module('../../../src/features/gallery/queries', () => ({
  useGalleryQuery: () => ({
    data: galleryQueryState.current.data,
    fetchNextPage: fetchNextPageMock,
    hasNextPage: galleryQueryState.current.hasNextPage,
    isFetchingNextPage: galleryQueryState.current.isFetchingNextPage,
    status: galleryQueryState.current.status,
  }),
}));

// After the mock, never before: a static import is evaluated first and would
// bind GalleryPage to the real gallery queries.
const { GalleryPage } = await import('../../../src/features/gallery/GalleryPage');

const TEST_ITEM: GalleryItem = {
  id: 'img-42',
  chatId: 'chat-1',
  messageId: 'message-1',
  prompt: 'Aurora over a quiet mountain lake',
  imageUrl: 'https://example.com/generated/aurora.png',
  createdAt: 1,
};

let intersectionCallback: IntersectionObserverCallback | null = null;
const OriginalIntersectionObserver = globalThis.IntersectionObserver;

class TestIntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [];

  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }

  observe() {
    // noop in tests
  }

  unobserve() {
    // noop in tests
  }

  disconnect() {
    // noop in tests
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function setGalleryState(overrides: Partial<(typeof galleryQueryState)['current']>) {
  galleryQueryState.current = {
    data: undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
    status: 'success',
    ...overrides,
  };
}

function triggerIntersection(isIntersecting: boolean) {
  if (!intersectionCallback) {
    throw new Error('Intersection observer callback was not registered.');
  }

  intersectionCallback(
    [{ isIntersecting } as IntersectionObserverEntry],
    {} as IntersectionObserver
  );
}

describe('GalleryPage', () => {
  beforeEach(() => {
    fetchNextPageMock.mockReset();
    setGalleryState({ status: 'pending' });
    intersectionCallback = null;
    globalThis.IntersectionObserver =
      TestIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    globalThis.IntersectionObserver = OriginalIntersectionObserver;
  });

  it('renders the empty state after loading completes with no images', async () => {
    setGalleryState({
      data: { pages: [{ items: [], nextCursor: null }], pageParams: [null] },
      status: 'success',
    });

    render(<GalleryPage />);

    await screen.findByText(/your creations will appear here/i);
  });

  it('opens a lightbox with a downloadable full image', async () => {
    const user = userEvent.setup();
    setGalleryState({
      data: { pages: [{ items: [TEST_ITEM], nextCursor: null }], pageParams: [null] },
      status: 'success',
    });

    const { container } = render(<GalleryPage />);

    expect(screen.getByAltText(TEST_ITEM.prompt)).toBeInTheDocument();
    expect(container.querySelector('a[download="mangostudio-art-img-42.png"]')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /view/i }));

    const downloadLink = screen.getByRole('link', { name: /download full image/i });
    expect(downloadLink).toHaveAttribute('download', 'mangostudio-art-img-42.png');

    const closeButton = container.querySelector('button.absolute.top-6.right-6');
    expect(closeButton).not.toBeNull();
    await user.click(closeButton as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /download full image/i })).not.toBeInTheDocument();
    });
  });

  it('requests the next gallery page when the sentinel becomes visible', async () => {
    setGalleryState({
      data: { pages: [{ items: [TEST_ITEM], nextCursor: 'cursor-2' }], pageParams: [null] },
      hasNextPage: true,
      status: 'success',
    });

    render(<GalleryPage />);

    triggerIntersection(true);

    await waitFor(() => {
      expect(fetchNextPageMock).toHaveBeenCalledTimes(1);
    });
  });
});
