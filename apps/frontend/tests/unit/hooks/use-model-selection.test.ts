import type { Connector, ModelCatalogResponse } from '@mangostudio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelSelection } from '../../../src/features/settings/connectors/hooks/use-model-selection';
import { act, renderHook } from '../../support/harness/render';

const mockUpdateConnectorModels = vi.fn();

vi.mock('../../../src/features/settings/connectors/api', () => ({
  updateConnectorModels: (...args: unknown[]): Promise<void> =>
    mockUpdateConnectorModels(...args) as Promise<void>,
}));

function makeCatalog(overrides: Partial<ModelCatalogResponse> = {}): ModelCatalogResponse {
  return {
    configured: true,
    status: 'ready',
    allModels: [],
    textModels: [],
    imageModels: [],
    discoveredTextModels: [],
    discoveredImageModels: [],
    ...overrides,
  };
}

function makeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'conn-1',
    name: 'OpenAI',
    provider: 'openai',
    configured: true,
    source: 'bun-secrets',
    maskedSuffix: null,
    updatedAt: 0,
    lastValidatedAt: null,
    lastValidationError: null,
    enabledModels: [],
    userId: null,
    baseUrl: null,
    organizationId: null,
    projectId: null,
    ...overrides,
  };
}

describe('useModelSelection', () => {
  beforeEach(() => {
    mockUpdateConnectorModels.mockReset();
    mockUpdateConnectorModels.mockResolvedValue(undefined);
  });

  it('starts with no selected connector and empty search query', () => {
    const { result } = renderHook(() => useModelSelection(makeCatalog(), vi.fn(), vi.fn()));

    expect(result.current.selectedConnector).toBeNull();
    expect(result.current.modelSearchQuery).toBe('');
  });

  it('opens modal for a connector and clears search', () => {
    const { result } = renderHook(() => useModelSelection(makeCatalog(), vi.fn(), vi.fn()));

    act(() => {
      result.current.openModals(makeConnector({ name: 'Test' }));
    });

    expect(result.current.selectedConnector).toEqual(makeConnector({ name: 'Test' }));
    expect(result.current.modelSearchQuery).toBe('');
  });

  it('closes modal and clears selected connector', () => {
    const { result } = renderHook(() => useModelSelection(makeCatalog(), vi.fn(), vi.fn()));

    act(() => {
      result.current.openModals(makeConnector());
    });
    act(() => {
      result.current.closeModal();
    });

    expect(result.current.selectedConnector).toBeNull();
  });

  it('getDiscoveredModels filters by connector provider', () => {
    const catalog = makeCatalog({
      discoveredTextModels: [
        { modelId: 'gpt-4', provider: 'openai' },
        { modelId: 'gpt-3', provider: 'openai' },
        { modelId: 'claude', provider: 'anthropic' },
        { modelId: 'generic' },
      ] as ModelCatalogResponse['discoveredTextModels'],
      discoveredImageModels: [
        { modelId: 'dall-e', provider: 'openai' },
        { modelId: 'sd', provider: 'stability' },
      ] as ModelCatalogResponse['discoveredImageModels'],
    });

    const { result } = renderHook(() => useModelSelection(catalog, vi.fn(), vi.fn()));
    const models = result.current.getDiscoveredModels(makeConnector({ provider: 'openai' }));

    expect(models.textModels).toHaveLength(3);
    expect(models.textModels.map((m) => m.modelId)).toEqual(['gpt-4', 'gpt-3', 'generic']);
    expect(models.imageModels).toHaveLength(1);
    expect(models.imageModels[0]?.modelId).toBe('dall-e');
  });

  it('toggles a model on and persists', async () => {
    const reloadConnectors = vi.fn().mockResolvedValue(undefined);
    const reloadModelCatalog = vi.fn().mockResolvedValue(undefined);
    const connector = makeConnector({ id: 'c1', enabledModels: [] });

    const { result } = renderHook(() =>
      useModelSelection(makeCatalog(), reloadConnectors, reloadModelCatalog)
    );

    act(() => {
      result.current.openModals(connector);
    });

    await act(async () => {
      await result.current.handleToggleModel('m1', true);
    });

    expect(result.current.selectedConnector?.enabledModels).toEqual(['m1']);
    expect(mockUpdateConnectorModels).toHaveBeenCalledWith('c1', ['m1']);
    expect(reloadConnectors).toHaveBeenCalled();
    expect(reloadModelCatalog).toHaveBeenCalled();
  });

  it('toggles a model off and persists', async () => {
    const reloadConnectors = vi.fn().mockResolvedValue(undefined);
    const reloadModelCatalog = vi.fn().mockResolvedValue(undefined);
    const connector = makeConnector({ id: 'c1', enabledModels: ['m1', 'm2'] });

    const { result } = renderHook(() =>
      useModelSelection(makeCatalog(), reloadConnectors, reloadModelCatalog)
    );

    act(() => {
      result.current.openModals(connector);
    });

    await act(async () => {
      await result.current.handleToggleModel('m1', false);
    });

    expect(result.current.selectedConnector?.enabledModels).toEqual(['m2']);
    expect(mockUpdateConnectorModels).toHaveBeenCalledWith('c1', ['m2']);
  });

  it('does nothing when toggling without a selected connector', async () => {
    const { result } = renderHook(() => useModelSelection(makeCatalog(), vi.fn(), vi.fn()));

    await act(async () => {
      await result.current.handleToggleModel('m1', true);
    });

    expect(mockUpdateConnectorModels).not.toHaveBeenCalled();
  });

  it('swallows update errors and logs them', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* swallow expected error logs in test */
    });
    mockUpdateConnectorModels.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useModelSelection(makeCatalog(), vi.fn(), vi.fn()));

    act(() => {
      result.current.openModals(makeConnector({ id: 'c1', enabledModels: [] }));
    });

    await act(async () => {
      await result.current.handleToggleModel('m1', true);
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      '[connectors] Failed to update models',
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });
});
