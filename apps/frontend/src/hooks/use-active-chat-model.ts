import type { ProviderType } from '@mangostudio/shared/types';
import { useCallback, useMemo } from 'react';
import { useProviderSettings } from '@/features/settings/providers/hooks/use-provider-settings';
import { resolveActiveModeModel } from '@/utils/model-utils';
import type { useGlobalSettings } from './use-global-settings';
import type { useModelCatalog } from './use-model-catalog';

interface UseActiveChatModelParams {
  readonly catalog: ReturnType<typeof useModelCatalog>['catalog'];
  /** Whether the hub has answered with a catalog yet (`useModelCatalog().isResolved`). */
  readonly isCatalogResolved: boolean;
  readonly settings: ReturnType<typeof useGlobalSettings>;
  readonly currentTextModel?: string | null;
}

export function useActiveChatModel({
  catalog,
  isCatalogResolved,
  settings,
  currentTextModel,
}: UseActiveChatModelParams) {
  const activeModels = catalog.textModels;
  const activeModel = useMemo(
    () => resolveActiveModeModel(currentTextModel ?? undefined, undefined, activeModels),
    [activeModels, currentTextModel]
  );
  const getActiveModel = useCallback(() => activeModel, [activeModel]);
  const isModelSelectorDisabled = catalog.status !== 'ready' || activeModels.length === 0;
  // Until the catalog answers, `activeModel` is '' for every chat — not the
  // chat's model, and not a choice anyone made. A turn sent then would run on
  // whatever the hub resolves, not on what the composer is about to show.
  const isModelResolving = !isCatalogResolved;

  const lockedProvider = useMemo((): ProviderType | null => {
    if (!currentTextModel) return null;
    const modelOption = activeModels.find((model) => model.modelId === currentTextModel);
    return modelOption?.provider ?? null;
  }, [activeModels, currentTextModel]);

  const { descriptor: providerDescriptor } = useProviderSettings(lockedProvider);
  const effectiveThinkingEnabled =
    providerDescriptor?.settings.thinkingEnabled ?? settings.thinkingEnabled;
  const effectiveReasoningEffort =
    providerDescriptor?.settings.reasoningEffort ?? settings.reasoningEffort;
  const effectiveMaxToolIterations =
    providerDescriptor?.settings.maxToolIterations ?? settings.maxToolIterations;

  return {
    activeModels,
    activeModel,
    getActiveModel,
    isModelSelectorDisabled,
    isModelResolving,
    lockedProvider,
    effectiveThinkingEnabled,
    effectiveReasoningEffort,
    effectiveMaxToolIterations,
  };
}
