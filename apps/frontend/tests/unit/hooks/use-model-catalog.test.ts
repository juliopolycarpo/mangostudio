import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { useQueryClient } from '@tanstack/react-query';
import { chatCapabilitiesQueryOptions } from '../../../src/features/chat/hooks/use-chat-capabilities';
import { EMPTY_MODEL_CATALOG, LOADING_MODEL_CATALOG } from '../../../src/utils/model-utils';
import { act, renderHook, waitFor } from '../../support/harness/render';

// No Bun equivalent for `vi.mocked` — the `jest.fn()` handle created here is
// what the factory below hands back, so keep it instead.
const mockGet = jest.fn();

mock.module('../../../src/lib/api-client', () => ({
  client: {
    api: {
      settings: {
        models: {
          get: mockGet,
        },
      },
    },
  },
}));

// Static imports are evaluated before any statement above runs, so the hook
// has to come in afterwards or it binds the real api-client.
const { useModelCatalog } = await import('../../../src/hooks/use-model-catalog');

const CAPABILITIES_KEY: readonly unknown[] = chatCapabilitiesQueryOptions({
  chatId: 'chat-1',
}).queryKey;

type MockGetResult = Awaited<ReturnType<typeof mockGet>>;
function mockResult(data: unknown, error: unknown = null) {
  return { data, error } as unknown as MockGetResult;
}

describe('useModelCatalog', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('reports a loading catalog, not an empty one, until the hub answers', async () => {
    mockGet.mockResolvedValue(mockResult({ ...EMPTY_MODEL_CATALOG, status: 'ready' }));

    const { result } = renderHook(() => useModelCatalog());

    // The shell renders before this request lands; "no models" would be a lie.
    expect(
      result.current.catalog.status,
      `expected catalog status before the first answer: loading | received: ${result.current.catalog.status}`
    ).toBe('loading');
    expect(result.current.catalog).toEqual(LOADING_MODEL_CATALOG);
    expect(result.current.isResolved).toBe(false);
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.catalog.status).toBe('ready');
  });

  it.each([
    {
      label: 'openai-shaped',
      mockCatalog: {
        configured: true,
        status: 'ready' as const,
        allModels: [
          {
            modelId: 'gpt-4o',
            displayName: 'GPT-4o',
            description: '',
            supportedActions: ['generateContent'],
            provider: 'openai-compatible' as const,
          },
        ],
        textModels: [],
        imageModels: [],
        discoveredTextModels: [],
        discoveredImageModels: [],
      },
    },
    {
      label: 'gemini-shaped',
      mockCatalog: {
        configured: true,
        status: 'ready' as const,
        allModels: [
          {
            modelId: 'gemini-2.5-flash',
            resourceName: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            description: 'Fast model',
            supportedActions: ['generateContent'],
          },
        ],
        textModels: [],
        imageModels: [],
        discoveredTextModels: [],
        discoveredImageModels: [],
      },
    },
  ])('updates catalog after a successful fetch ($label)', async ({ mockCatalog }) => {
    mockGet.mockResolvedValue(mockResult(mockCatalog));

    const { result } = renderHook(() => useModelCatalog());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // `expect<unknown>` because bun-types types `toEqual` against the
    // received type, and the two `it.each` rows above answer with
    // provider-shaped catalogs the full `ModelCatalog` type does not list.
    expect<unknown>(result.current.catalog).toEqual(mockCatalog);
  });

  it('keeps the empty catalog when the initial fetch fails', async () => {
    mockGet.mockResolvedValue(mockResult(null, { value: 'Network error' }));

    const { result } = renderHook(() => useModelCatalog());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.catalog).toEqual(EMPTY_MODEL_CATALOG);
    expect(result.current.isResolved, 'expected a refused catalog to stay unresolved').toBe(false);
  });

  it('supports manual refresh', async () => {
    const initialCatalog = {
      configured: true,
      status: 'ready' as const,
      allModels: [],
      textModels: [],
      imageModels: [],
      discoveredTextModels: [],
      discoveredImageModels: [],
    };
    const updatedCatalog = { ...initialCatalog, configured: false };

    mockGet.mockResolvedValue(mockResult(initialCatalog));

    const { result } = renderHook(() => ({
      catalog: useModelCatalog(),
      queryClient: useQueryClient(),
    }));

    await waitFor(() => expect(result.current.catalog.isLoading).toBe(false));
    result.current.queryClient.setQueryData(CAPABILITIES_KEY, { runtimeHash: 'cached' });

    mockGet.mockResolvedValue(mockResult(updatedCatalog));

    await act(async () => {
      await result.current.catalog.refreshCatalog();
    });

    await waitFor(() => {
      expect(result.current.catalog.catalog).toEqual(updatedCatalog);
    });
    expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(true);
  });

  it('leaves capability projections untouched when the refresh fails', async () => {
    const initialCatalog = {
      configured: true,
      status: 'ready' as const,
      allModels: [],
      textModels: [],
      imageModels: [],
      discoveredTextModels: [],
      discoveredImageModels: [],
    };

    mockGet.mockResolvedValue(mockResult(initialCatalog));

    const { result } = renderHook(() => ({
      catalog: useModelCatalog(),
      queryClient: useQueryClient(),
    }));

    await waitFor(() => expect(result.current.catalog.isLoading).toBe(false));
    result.current.queryClient.setQueryData(CAPABILITIES_KEY, { runtimeHash: 'cached' });

    mockGet.mockResolvedValue(mockResult(null, { value: 'Network error' }));

    await act(async () => {
      await result.current.catalog.refreshCatalog();
    });

    await waitFor(() => expect(result.current.catalog.isLoading).toBe(false));
    expect(result.current.catalog.catalog).toEqual(initialCatalog);
    expect(result.current.queryClient.getQueryState(CAPABILITIES_KEY)?.isInvalidated).toBe(false);
  });
});
