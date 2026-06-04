import { describe, expect, it, vi } from 'vitest';
import { galleryKeys, galleryListQueryOptions } from '../../../src/features/gallery/queries';

const { mockGetImages } = vi.hoisted(() => ({
  mockGetImages: vi.fn(),
}));

vi.mock('../../../src/lib/api-client', () => ({
  client: {
    api: {
      messages: {
        images: {
          get: mockGetImages,
        },
      },
    },
  },
}));

function getQueryFn() {
  const queryFn = galleryListQueryOptions().queryFn;
  if (!queryFn) {
    throw new Error('galleryListQueryOptions queryFn is required for these tests.');
  }

  return queryFn;
}

describe('gallery queries', () => {
  it('uses a stable gallery list key', () => {
    expect(galleryKeys.lists()).toEqual(['gallery', 'list']);
  });

  it('requests the first page with the default limit', async () => {
    mockGetImages.mockResolvedValue({ data: { items: [], nextCursor: null }, error: null });

    const queryFn = getQueryFn();
    const data = await queryFn({ pageParam: null } as never);

    expect(mockGetImages).toHaveBeenCalledWith({ query: { limit: '20' } });
    expect(data).toEqual({ items: [], nextCursor: null });
  });

  it('requests subsequent pages with the cursor', async () => {
    mockGetImages.mockResolvedValue({ data: { items: [], nextCursor: null }, error: null });

    const queryFn = getQueryFn();
    await queryFn({ pageParam: 'cursor-2' } as never);

    expect(mockGetImages).toHaveBeenCalledWith({
      query: { cursor: 'cursor-2', limit: '20' },
    });
  });

  it('throws the API error message for gallery fetch failures', async () => {
    mockGetImages.mockResolvedValue({
      data: null,
      error: { value: { error: 'Gallery is unavailable' } },
    });

    const queryFn = getQueryFn();

    await expect(queryFn({ pageParam: null } as never)).rejects.toThrow('Gallery is unavailable');
  });
});
