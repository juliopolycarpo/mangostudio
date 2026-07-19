/**
 * Hook: model enable/disable state, search/filter, and save.
 */

import type { Connector, ModelCatalogResponse } from '@mangostudio/shared';
import { useRef, useState } from 'react';
import { updateConnectorModels } from '../api';

function withModelToggled(enabledModels: string[], modelId: string, checked: boolean): string[] {
  return checked
    ? enabledModels.includes(modelId)
      ? enabledModels
      : [...enabledModels, modelId]
    : enabledModels.filter((id) => id !== modelId);
}

export function useModelSelection(
  modelCatalog: ModelCatalogResponse,
  reloadConnectors: () => Promise<void>,
  reloadModelCatalog: () => Promise<void>,
  onToggleError: (err: unknown) => void
) {
  const [selectedConnector, setSelectedConnector] = useState<Connector | null>(null);
  const selectedConnectorRef = useRef(selectedConnector);
  selectedConnectorRef.current = selectedConnector;
  const [modelSearchQuery, setModelSearchQuery] = useState('');

  const openModals = (connector: Connector) => {
    selectedConnectorRef.current = connector;
    setSelectedConnector(connector);
    setModelSearchQuery('');
  };

  const closeModal = () => {
    selectedConnectorRef.current = null;
    setSelectedConnector(null);
  };

  const getDiscoveredModels = (connector: Connector) => {
    const textModels = modelCatalog.discoveredTextModels.filter(
      (m) => !m.provider || m.provider === connector.provider
    );
    const imageModels = modelCatalog.discoveredImageModels.filter(
      (m) => !m.provider || m.provider === connector.provider
    );
    return { textModels, imageModels };
  };

  const handleToggleModel = async (modelId: string, checked: boolean) => {
    const current = selectedConnectorRef.current;
    if (!current) return;
    const connectorId = current.id;
    const next = withModelToggled(current.enabledModels, modelId, checked);
    const optimistic = { ...current, enabledModels: next };
    selectedConnectorRef.current = optimistic;
    setSelectedConnector(optimistic);

    try {
      await updateConnectorModels(connectorId, next);
      await reloadConnectors();
      await reloadModelCatalog();
    } catch (err) {
      setSelectedConnector((prev) => {
        if (!prev || prev.id !== connectorId) return prev;
        const reverted = {
          ...prev,
          enabledModels: withModelToggled(prev.enabledModels, modelId, !checked),
        };
        selectedConnectorRef.current = reverted;
        return reverted;
      });
      onToggleError(err);
    }
  };

  return {
    selectedConnector,
    modelSearchQuery,
    setModelSearchQuery,
    openModals,
    closeModal,
    getDiscoveredModels,
    handleToggleModel,
  };
}
