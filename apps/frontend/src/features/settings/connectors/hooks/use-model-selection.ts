/**
 * Hook: model enable/disable state, search/filter, and save.
 */

import { useState } from 'react';
import type { Connector, ModelCatalogResponse } from '@mangostudio/shared';
import { updateConnectorModels } from '../api';

export function useModelSelection(
  modelCatalog: ModelCatalogResponse,
  reloadConnectors: () => Promise<void>,
  reloadModelCatalog: () => Promise<void>
) {
  const [selectedConnector, setSelectedConnector] = useState<Connector | null>(null);
  const [modelSearchQuery, setModelSearchQuery] = useState('');

  const openModals = (connector: Connector) => {
    setSelectedConnector(connector);
    setModelSearchQuery('');
  };

  const closeModal = () => setSelectedConnector(null);

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
    if (!selectedConnector) return;
    const next = checked
      ? [...selectedConnector.enabledModels, modelId]
      : selectedConnector.enabledModels.filter((id) => id !== modelId);

    setSelectedConnector({ ...selectedConnector, enabledModels: next });
    try {
      await updateConnectorModels(selectedConnector.id, next);
      await reloadConnectors();
      await reloadModelCatalog();
    } catch (err) {
      console.error('[connectors] Failed to update models', err);
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
