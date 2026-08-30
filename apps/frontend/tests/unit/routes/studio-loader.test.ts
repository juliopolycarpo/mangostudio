/**
 * The studio loader's job is to make the recent strip's four images available,
 * and to stop there.
 *
 * The strip shares the gallery's infinite query, and `prefetchInfiniteQuery`
 * refetches an existing infinite query at its current page count — one
 * sequential request per page, with the loader awaiting all of them. Landing on
 * the studio after browsing the gallery would then cost a request per page
 * scrolled to show the same four images, so the loader is expected to leave a
 * warm cache alone.
 *
 * Driven through a real `QueryClient` with a counting fetcher rather than a
 * mocked client: what is worth asserting is how many requests leave, which a
 * stub standing in for the client would only assert about itself.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

const galleryKeys = {
  all: ['gallery'] as const,
  lists: () => ['gallery', 'list'] as const,
};

interface PageFetch {
  readonly cursor: string | null;
}

interface GalleryPage {
  readonly items: Array<{ id: string }>;
  readonly nextCursor: string | null;
}

/**
 * A gallery whose pages are counted instead of fetched.
 *
 * Named rather than inline so the request log belongs to the fake, and shaped
 * like `galleryListQueryOptions()` so the loader cannot tell the difference.
 */
class CountingGallery {
  readonly requests: PageFetch[] = [];

  /** Enough pages that a full replay is unmistakable next to a single fetch. */
  constructor(private readonly pageCount = 5) {}

  options() {
    return {
      queryKey: galleryKeys.lists(),
      queryFn: ({ pageParam }: { pageParam: string | null }): Promise<GalleryPage> => {
        this.requests.push({ cursor: pageParam });
        const index = pageParam === null ? 0 : Number(pageParam);
        return Promise.resolve({
          items: [{ id: `img-${index}` }],
          nextCursor: index < this.pageCount - 1 ? String(index + 1) : null,
        });
      },
      initialPageParam: null as string | null,
      getNextPageParam: (last: GalleryPage) => last.nextCursor,
    };
  }
}

/** The same shape, for the gallery the hub cannot reach. */
class UnreachableGallery {
  options() {
    return {
      queryKey: galleryKeys.lists(),
      queryFn: (): Promise<GalleryPage> => Promise.reject(new Error('gallery unreachable')),
      initialPageParam: null as string | null,
      getNextPageParam: (last: GalleryPage) => last.nextCursor,
    };
  }
}

const gallery: { current: CountingGallery | UnreachableGallery } = {
  current: new CountingGallery(),
};

// Before the route is imported, never after: a static import is evaluated
// first and would bind the loader to the real query, which fetches over HTTP.
mock.module('../../../src/features/gallery/queries', () => ({
  galleryKeys,
  galleryListQueryOptions: () => gallery.current.options(),
  useGalleryQuery: () => ({ data: undefined, status: 'pending' }),
}));

const { Route: StudioRoute } = await import('../../../src/routes/_authenticated/studio');

type Loader = (ctx: { context: { queryClient: QueryClient } }) => Promise<unknown> | undefined;

/** The loader as the file route keeps it, in its options bag. */
const loader = (StudioRoute as unknown as { options: { loader: Loader } }).options.loader;

/**
 * `staleTime: 0`, so cached pages count as stale the moment they land.
 *
 * Staleness is what arms the replay: a prefetch against fresh data returns
 * without fetching, so a client carrying the app's real 30s window would let
 * the unguarded loader pass these tests by being too quick to look. The app
 * reaches this state by the ordinary route — half a minute spent on `/gallery`
 * before clicking through to the studio.
 */
function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
}

/** Leaves the client holding the pages a user would have scrolled through. */
function browseGallery(client: QueryClient, pages: number): Promise<unknown> {
  return client.fetchInfiniteQuery({ ...gallery.current.options(), pages });
}

function countingGallery(): CountingGallery {
  const counting = new CountingGallery();
  gallery.current = counting;
  return counting;
}

beforeEach(() => {
  gallery.current = new CountingGallery();
});

describe('studio route loader', () => {
  it('fetches exactly one page into a cold cache', async () => {
    const counting = countingGallery();

    await loader({ context: { queryClient: newClient() } });

    expect(counting.requests).toEqual([{ cursor: null }]);
  });

  // The regression: five cached pages used to mean five sequential requests
  // before the studio would paint, and ten after ten pages of scrolling.
  it('leaves a warm cache alone however deeply the gallery was browsed', async () => {
    const counting = countingGallery();
    const client = newClient();
    await browseGallery(client, 5);
    counting.requests.length = 0;

    await loader({ context: { queryClient: client } });

    expect(counting.requests).toEqual([]);
  });

  // Bounding the refetch with `pages: 1` would have been the other way to stop
  // the replay, at the cost of dropping the rest of the gallery's pages.
  it('keeps every page the gallery had loaded', async () => {
    countingGallery();
    const client = newClient();
    await browseGallery(client, 5);

    await loader({ context: { queryClient: client } });

    const cached = client.getQueryData(galleryKeys.lists()) as { pages: unknown[] };
    expect(cached.pages).toHaveLength(5);
  });

  // A cold gallery that will not load is the strip's error to report, not the
  // route's: the loader settles either way rather than reaching the boundary.
  it('does not reject when the cold fetch fails', async () => {
    gallery.current = new UnreachableGallery();

    expect(await loader({ context: { queryClient: newClient() } })).toBeUndefined();
  });
});
