import type { ProviderType } from '@mangostudio/shared';
import { useCallback, useMemo } from 'react';
import { useProviderSettings } from '@/features/settings/providers/hooks/use-provider-settings';
import { resolveActiveModeModel } from '@/utils/model-utils';
import type { useGlobalSettings } from './use-global-settings';
import type { useModelCatalog } from './use-model-catalog';

interface UseActiveChatModelParams {
  readonly catalog: ReturnType<typeof useModelCatalog>['catalog'];
  readonly settings: ReturnType<typeof useGlobalSettings>;
  readonly currentTextModel?: string | null;
}

export function useActiveChatModel({
  catalog,
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
    lockedProvider,
    effectiveThinkingEnabled,
    effectiveReasoningEffort,
    effectiveMaxToolIterations,
  };
}
