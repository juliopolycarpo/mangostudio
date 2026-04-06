import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MODEL_CATALOG } from '../../../src/utils/model-utils';
import { useModelCatalog as useGeminiCatalog } from '../../../src/hooks/use-model-catalog';
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

describe('useGeminiCatalog', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('returns the initial empty catalog state', () => {
    mockGet.mockResolvedValue(mockResult(EMPTY_MODEL_CATALOG));

    const { result } = renderHook(() => useGeminiCatalog());

    expect(result.current.catalog).toEqual(EMPTY_MODEL_CATALOG);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('updates catalog after a successful refresh', async () => {
    const mockCatalog = {
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
    };

    mockGet.mockResolvedValue(mockResult(mockCatalog));

    const { result } = renderHook(() => useGeminiCatalog());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.catalog).toEqual(mockCatalog);
    expect(result.current.error).toBeNull();
  });

  it('handles API errors', async () => {
    mockGet.mockResolvedValue(mockResult(null, { value: 'Network error' }));

    const { result } = renderHook(() => useGeminiCatalog());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Network error');
    expect(result.current.catalog).toEqual(EMPTY_MODEL_CATALOG);
  });

  it('allows manual refresh', async () => {
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

    const { result } = renderHook(() => useGeminiCatalog());

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
