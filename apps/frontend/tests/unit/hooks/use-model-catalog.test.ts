import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MODEL_CATALOG } from '../../../src/utils/model-utils';
import { useModelCatalog } from '../../../src/hooks/use-model-catalog';
import { client } from '../../../src/lib/api-client';
import { act, renderHook, waitFor } from '../../support/harness/render';

vi.mock('../../../src/lib/api-client', () => ({
  client: {
    api: {
      settings: {
        models: {
          get: vi.fn(),
        },
      },
    },
  },
}));

const mockGet = vi.mocked(client.api.settings.models.get);

type MockGetResult = Awaited<ReturnType<typeof mockGet>>;
function mockResult(data: unknown, error: unknown = null) {
  return { data, error } as unknown as MockGetResult;
}

describe('useModelCatalog', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('returns the initial empty catalog state', () => {
    mockGet.mockResolvedValue(mockResult(EMPTY_MODEL_CATALOG));

    const { result } = renderHook(() => useModelCatalog());

    expect(result.current.catalog).toEqual(EMPTY_MODEL_CATALOG);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('updates catalog after a successful fetch', async () => {
    const mockCatalog = {
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
    };

    mockGet.mockResolvedValue(mockResult(mockCatalog));

    const { result } = renderHook(() => useModelCatalog());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.catalog).toEqual(mockCatalog);
    expect(result.current.error).toBeNull();
  });

  it('handles API errors gracefully', async () => {
    mockGet.mockResolvedValue(mockResult(null, { value: 'Network error' }));

    const { result } = renderHook(() => useModelCatalog());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Network error');
    expect(result.current.catalog).toEqual(EMPTY_MODEL_CATALOG);
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

    const { result } = renderHook(() => useModelCatalog());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockGet.mockResolvedValue(mockResult(updatedCatalog));

    await act(async () => {
      await result.current.refreshCatalog();
    });

    await waitFor(() => {
      expect(result.current.catalog).toEqual(updatedCatalog);
    });
  });
});
